import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../host/engine.js';
import { resolveConfig } from '../host/util.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

/** Minimal conversation-aware doubles: one group, one conversation, one member. */
function fixture(t, options = {}) {
  const groups = new Map([['group', { groupId: 'group', title: 'Group', nextSeq: 0, activeConversationId: 'conv-1' }]]);
  const conversations = new Map([['conv-1', { conversationId: 'conv-1', groupId: 'group', ordinal: 1, afterSeq: 0, previousConversationId: null }]]);
  const members = new Map([['member', { membershipId: 'member', botId: 'bot', groupId: 'group', sessionId: 'session-1', sessionConversationId: 'conv-1', lastSeenSeq: 0 }]]);
  const bots = new Map([['bot', { botId: 'bot', name: 'Tester', provider: 'mock', model: 'mock' }]]);
  const messages = new Map();
  const frames = []; const submissions = []; const hooks = []; const agents = new Map();
  const repo = {
    groups, conversations, members, bots, messages,
    getGroup: id => groups.get(id), getMember: id => members.get(id), getBot: id => bots.get(id), getMessage: id => messages.get(id),
    getTask: () => undefined, getDiscussion: () => undefined,
    discussionsOf: () => [],
    activeConversation: gid => conversations.get(groups.get(gid)?.activeConversationId),
    conversationsOf: gid => [...conversations.values()].filter(conversation => conversation.groupId === gid),
    conversationFor(record) {
      if (!record) return undefined;
      const found = record.conversationId
        ? conversations.get(record.conversationId)
        : Number.isInteger(record.seq) ? repo.conversationsOf(record.groupId).findLast(conversation => record.seq > conversation.afterSeq) : undefined;
      return found?.groupId === record.groupId ? found : undefined;
    },
    sessionBindingFor: sessionId => [...members.values()].some(member => member.sessionId === sessionId)
      ? { sessionId, groupId: 'group', conversationId: 'conv-1', membershipId: 'member', botId: 'bot' } : undefined,
    membersOf: gid => [...members.values()].filter(member => member.groupId === gid),
    messagesOf: gid => [...messages.values()].filter(message => message.groupId === gid).sort((a, b) => a.seq - b.seq),
    messagesBetween: (gid, from, to) => repo.messagesOf(gid).filter(message => message.seq > from && message.seq <= to),
    lastMessageOf: gid => repo.messagesOf(gid).at(-1),
    allocateSeq: gid => ++groups.get(gid).nextSeq,
    appendMessage(message) { messages.set(message.messageId, message); },
    putMessage(message) { messages.set(message.messageId, message); return Promise.resolve(); },
    async putMessageStrict(message) { messages.set(message.messageId, message); },
    async putMemberStrict(member) { members.set(member.membershipId, structuredClone(member)); return members.get(member.membershipId); },
    touchMember(member) { members.set(member.membershipId, member); },
  };
  const ctx = { on: () => () => {}, agents: { get: id => agents.get(id) }, get: () => undefined };
  function agent(sessionId) {
    if (!agents.has(sessionId)) agents.set(sessionId, {
      id: sessionId, session: { id: sessionId, seq: 0, events: [], snapshotEvents() { return this.events; } },
      cancel() {},
      followup: async input => { submissions.push({ sessionId, input: structuredClone(input) }); },
    });
    return agents.get(sessionId);
  }
  agent('session-1');
  const pool = {
    attachClaimHandler: () => () => {}, owns: () => true,
    memberForSession: sessionId => [...members.values()].find(member => member.sessionId === sessionId),
    async ensure(id) { return agent(members.get(id).sessionId); },
    submit: (handle, input) => handle.followup(input),
  };
  const engine = new Engine({
    ctx, repo, pool, config: resolveConfig({ resultMode: options.resultMode }),
    personas: { refresh: async () => {} }, logger: { warn() {} },
    taskHook: (...args) => hooks.push(args),
    bus: { emit: (groupId, frame) => frames.push({ groupId, ...structuredClone(frame) }) },
  });
  const f = {
    repo, engine, frames, submissions, hooks, agents,
    async flush() { for (let index = 0; index < 8; index += 1) await tick(); },
    async post(extra = {}) {
      const result = engine.postHumanMessage({ groupId: 'group', text: 'REQUEST', mentions: ['member'], ...extra });
      await f.flush();
      return { ...result, job: engine.running.get('member') };
    },
    async review(targetMessageId) {
      const result = engine.requestReview({ groupId: 'group', targetMessageId, reviewerMembershipId: 'member' });
      await f.flush();
      return { ...result, job: engine.running.get('member') };
    },
    message(job) { return repo.getMessage(job.placeholderId); },
    framesOfType(type) { return frames.filter(frame => frame.type === type); },
    event(job, type, data) {
      const session = agents.get(job.sessionId).session;
      const event = { seq: session.seq++, type, data };
      session.events.push(event); engine.onSessionEvent(session, event); return event;
    },
    begin(job, turn = 1) {
      f.event(job, 'turn/start', { turn });
      engine.onInboxClaim({ agent: agents.get(job.sessionId), message: { id: job.execution.inputMessageId }, turn });
      f.event(job, 'user/message', { id: job.execution.inputMessageId, turn });
    },
    answer(job, text, { toolCall = false, phase } = {}) {
      const content = [];
      if (toolCall) content.push({ type: 'tool-call', callId: 'call-1', name: 'bash', arguments: '{}' });
      content.push({ type: 'text', text });
      const message = { content };
      if (phase) {
        message.source = {
          replayState: { attempts: [{ blocks: [{ textSignature: JSON.stringify({ v: 1, id: 'sig-' + phase, phase }) }] }] },
        };
      }
      f.event(job, 'assistant/message', { turn: job.turn, message });
    },
    end(job, reason = { kind: 'completed' }) { f.event(job, 'turn/end', { turn: job.turn, reason }); },
    streamStart(job, attemptId = 'attempt-1') {
      engine.onAssistantStream({ agent: agents.get(job.sessionId), frame: { type: 'start', turn: job.turn, attemptId } });
    },
    chunk(job, text, attemptId = 'attempt-1') {
      engine.onAssistantStream({
        agent: agents.get(job.sessionId),
        frame: { type: 'chunk', turn: job.turn, attemptId, chunk: { type: 'text-delta', text } },
      });
    },
  };
  t.after(async () => { await engine.dispose(); await f.flush(); });
  return f;
}

for (const [mode, expected] of [['full', 'COMMENTARY\n\nFINAL ANSWER'], ['final', 'FINAL ANSWER']]) {
  test(`${mode} mode projects ${mode === 'full' ? 'the accumulated transcript' : 'only the final answer'}`, async t => {
    const f = fixture(t, { resultMode: mode });
    const { job } = await f.post();
    f.begin(job);
    f.streamStart(job); f.chunk(job, 'STREAM_DELTA');
    f.answer(job, 'COMMENTARY', { toolCall: true });
    f.answer(job, 'FINAL ANSWER');
    f.end(job);
    await f.flush();
    const message = f.message(job);
    assert.equal(message.status, 'done');
    assert.equal(message.text, expected);
    assert.equal(message.text.includes('STREAM_DELTA'), false);
    if (mode === 'full') {
      assert.equal(f.framesOfType('message.delta').at(-1).chunk, 'STREAM_DELTA');
      assert.equal(f.framesOfType('message.replace').at(-1).text, 'COMMENTARY\n\nFINAL ANSWER');
      assert.equal(message.meta.resultProjection, undefined);
    } else {
      assert.equal(f.framesOfType('message.delta').length, 0);
      assert.equal(f.framesOfType('message.replace').length, 0);
      assert.deepEqual(message.meta.resultProjection, { stepCount: 2, finalAnswerStep: 2 });
    }
  });
}

test('final mode keeps the placeholder empty while steps stream', async t => {
  const f = fixture(t, { resultMode: 'final' });
  const { job } = await f.post();
  f.begin(job);
  f.streamStart(job); f.chunk(job, 'PARTIAL');
  f.answer(job, 'INTERNAL PLAN', { toolCall: true });
  assert.equal(f.message(job).text, '');
  assert.equal(f.message(job).status, 'pending');
  assert.equal(f.framesOfType('message.replace').length, 0);
  assert.equal(f.framesOfType('message.delta').length, 0);
});

test('final mode keeps the body empty without a proven final answer and keeps status/error', async t => {
  const cases = [
    { run: (f, job) => f.engine.abortJob(job, 'user'), status: 'stopped', error: '已停止' },
    { run: (f, job) => f.end(job, { kind: 'error', error: { message: 'boom' } }), status: 'error', error: 'boom' },
    { run: (f, job) => f.end(job, { kind: 'max-tokens' }), status: 'error', error: '达到输出上限' },
  ];
  for (const scenario of cases) {
    const f = fixture(t, { resultMode: 'final' });
    const { job } = await f.post();
    f.begin(job);
    f.answer(job, 'DRAFT WITH TOOL CALL', { toolCall: true });
    f.answer(job, 'COMMENTARY WITH PHASE', { phase: 'commentary' });
    scenario.run(f, job);
    await f.flush();
    const message = f.message(job);
    assert.equal(message.text, '');
    assert.equal(message.status, scenario.status);
    assert.equal(message.error, scenario.error);
  }
});

test('final mode accepts a text step signed as final_answer', async t => {
  const f = fixture(t, { resultMode: 'final' });
  const { job } = await f.post();
  f.begin(job);
  f.answer(job, 'SIGNED FINAL', { phase: 'final_answer' });
  f.end(job);
  await f.flush();
  assert.equal(f.message(job).text, 'SIGNED FINAL');
  assert.equal(f.message(job).status, 'done');
});

test('final mode never publishes a text step whose recorded phase is commentary', async t => {
  const f = fixture(t, { resultMode: 'final' });
  const { job } = await f.post();
  f.begin(job);
  f.answer(job, 'COMMENTARY ONLY', { phase: 'commentary' });
  f.end(job);
  await f.flush();
  const message = f.message(job);
  assert.equal(message.text, '');
  assert.equal(message.status, 'done');
  assert.equal(f.framesOfType('message.replace').length, 0);
});

test('final mode still publishes an unsigned text-only step through the native fallback', async t => {
  const f = fixture(t, { resultMode: 'final' });
  const { job } = await f.post();
  f.begin(job);
  f.answer(job, 'UNSIGNED FINAL');
  f.end(job);
  await f.flush();
  assert.equal(f.message(job).text, 'UNSIGNED FINAL');
});

test('final mode parses the review verdict from the final answer only', async t => {
  const f = fixture(t, { resultMode: 'final' });
  const human = (await f.post({ mentions: [] })).message;
  const { job } = await f.review(human.messageId);
  f.begin(job);
  f.answer(job, '结论：通过', { toolCall: true });
  f.answer(job, '结论：需修改');
  f.end(job);
  await f.flush();
  const message = f.message(job);
  assert.equal(message.kind, 'review');
  assert.equal(message.text, '结论：需修改');
  assert.equal(message.meta.verdict, 'changes');
});

test('final mode resets the projection across a native continuation', async t => {
  const f = fixture(t, { resultMode: 'final' });
  const { job } = await f.post();
  f.begin(job);
  f.answer(job, 'FIRST ANSWER');
  // The end is buffered behind the durable write; the continuation start lands
  // in job.following and is replayed after settlement.
  f.end(job);
  f.event(job, 'turn/start', { turn: 2 });
  await f.flush();
  const first = f.repo.messagesOf('group').find(message => message.text === 'FIRST ANSWER');
  assert.equal(first.status, 'done');
  assert.notEqual(job.placeholderId, first.messageId);
  assert.equal(job.awaitingContinuation, false);
  f.event(job, 'user/message', { id: 'continuation-input', turn: 2 });
  f.answer(job, 'SECOND ANSWER');
  f.event(job, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  await f.flush();
  assert.equal(f.message(job).text, 'SECOND ANSWER');
  assert.equal(f.message(job).status, 'done');
  assert.equal(first.text, 'FIRST ANSWER');
});
