import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../host/engine.js';
import { resolveConfig } from '../host/util.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

/** Conversation-aware doubles that can rotate the active conversation. */
function fixture(t, options = {}) {
  const groups = new Map([['group', { groupId: 'group', title: 'Group', nextSeq: 0, activeConversationId: 'conv-1', conversationVersion: 1 }]]);
  const conversations = new Map([['conv-1', { conversationId: 'conv-1', groupId: 'group', ordinal: 1, afterSeq: 0, previousConversationId: null }]]);
  const members = new Map([['member', { membershipId: 'member', botId: 'bot', groupId: 'group', sessionId: 'session-1', sessionConversationId: 'conv-1', lastSeenSeq: 0 }]]);
  const bots = new Map([['bot', { botId: 'bot', name: 'Tester', provider: 'mock', model: 'mock' }]]);
  const messages = new Map();
  const frames = []; const submissions = []; const hooks = []; const agents = new Map();
  const repo = {
    groups, conversations, members, bots, messages,
    getGroup: id => groups.get(id), getMember: id => members.get(id), getBot: id => bots.get(id), getMessage: id => messages.get(id),
    getTask: () => undefined, getDiscussion: () => undefined, discussionsOf: () => [],
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
      ? { sessionId, groupId: 'group', conversationId: groups.get('group').activeConversationId, membershipId: 'member', botId: 'bot' } : undefined,
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
    repo, engine, frames, submissions, hooks, agents, calls: { pumps: [], idles: [], after: [] },
    async flush() { for (let index = 0; index < 8; index += 1) await tick(); },
    async post(extra = {}) {
      const result = engine.postHumanMessage({ groupId: 'group', text: 'REQUEST', mentions: ['member'], ...extra });
      await f.flush();
      return { ...result, job: engine.running.get('member') };
    },
    message(job) { return repo.getMessage(job.placeholderId); },
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
    answer(job, text) {
      f.event(job, 'assistant/message', { turn: job.turn, message: { content: [{ type: 'text', text }] } });
    },
    end(job, reason = { kind: 'completed' }) { f.event(job, 'turn/end', { turn: job.turn, reason }); },
    switchConversation() {
      const group = groups.get('group');
      const conversationId = 'conv-' + (group.conversationVersion + 1);
      conversations.set(conversationId, {
        conversationId, groupId: 'group', ordinal: group.conversationVersion + 1,
        afterSeq: group.nextSeq, previousConversationId: group.activeConversationId,
      });
      groups.set('group', { ...group, activeConversationId: conversationId, conversationVersion: group.conversationVersion + 1 });
      return conversationId;
    },
    /** Observe post-rotation side effects of a settling job. */
    watch() {
      const pump = engine.pump.bind(engine);
      engine.pump = groupId => { f.calls.pumps.push(groupId); return pump(groupId); };
      const checkIdle = engine.checkIdle.bind(engine);
      engine.checkIdle = groupId => { f.calls.idles.push(groupId); return checkIdle(groupId); };
      const afterJobFinished = engine.afterJobFinished.bind(engine);
      engine.afterJobFinished = job => { f.calls.after.push(job.jobId); return afterJobFinished(job); };
    },
  };
  t.after(async () => { await engine.dispose(); await f.flush(); });
  return f;
}

for (const mode of ['full', 'final']) {
  test(`${mode} mode delivers a rotated job result to its original placeholder`, async t => {
    const f = fixture(t, { resultMode: mode });
    const { job } = await f.post();
    f.begin(job);
    f.answer(job, 'LATE ANSWER');
    const placeholderId = job.placeholderId;
    const count = f.repo.messages.size;
    const conversationId = f.switchConversation();
    const frameCount = f.frames.length;
    f.watch();
    f.end(job);
    await f.flush();
    const message = f.repo.getMessage(placeholderId);
    assert.equal(job.state, 'done');
    assert.equal(message.status, 'done');
    assert.equal(message.text, 'LATE ANSWER');
    assert.equal(message.conversationId, 'conv-1');
    assert.equal(message.meta.lateDelivery, true);
    assert.equal(typeof message.meta.execution.endSeq, 'number');
    assert.equal(f.repo.messages.size, count);
    assert.equal(f.repo.messagesOf('group').filter(item => item.conversationId === conversationId).length, 0);
    assert.ok(!f.frames.slice(frameCount).some(frame => frame.conversationId === conversationId));
    assert.equal(f.hooks.length, 0);
    assert.deepEqual(f.calls.pumps, []);
    assert.deepEqual(f.calls.idles, []);
    assert.deepEqual(f.calls.after, []);
    assert.equal(f.engine.running.size, 0);
  });
}

test('late delivery is idempotent across duplicate events after settlement', async t => {
  const f = fixture(t);
  const { job } = await f.post();
  f.begin(job);
  f.answer(job, 'ONLY ONCE');
  const placeholderId = job.placeholderId;
  f.switchConversation();
  f.end(job);
  await f.flush();
  const count = f.repo.messages.size;
  f.end(job);
  f.answer(job, 'DUPLICATE');
  f.event(job, 'turn/start', { turn: 2 });
  await f.flush();
  assert.equal(f.repo.messages.size, count);
  assert.equal(f.repo.getMessage(placeholderId).text, 'ONLY ONCE');
  assert.equal(f.repo.getMessage(placeholderId).status, 'done');
  assert.equal(f.repo.messagesOf('group').filter(message => message.text === 'DUPLICATE').length, 0);
});

test('late delivery keeps the real stop and error status', async t => {
  const cases = [
    {
      run: (f, job) => f.engine.abortJob(job, 'user'),
      status: 'stopped', error: '已停止',
    },
    {
      run: (f, job) => f.end(job, { kind: 'error', error: { message: 'boom' } }),
      status: 'error', error: 'boom',
    },
  ];
  for (const scenario of cases) {
    const f = fixture(t);
    const { job } = await f.post();
    f.begin(job);
    f.answer(job, 'PARTIAL');
    const placeholderId = job.placeholderId;
    f.switchConversation();
    f.watch();
    scenario.run(f, job);
    await f.flush();
    const message = f.repo.getMessage(placeholderId);
    assert.equal(job.state, scenario.status);
    assert.equal(message.status, scenario.status);
    assert.equal(message.error, scenario.error);
    assert.equal(message.text, 'PARTIAL');
    assert.equal(message.meta.lateDelivery, true);
    assert.equal(f.hooks.length, 0);
    assert.deepEqual(f.calls.pumps, []);
  }
});

test('a member session rotation without a conversation rotation keeps the stale drop behavior', async t => {
  const f = fixture(t);
  const { job } = await f.post();
  f.begin(job);
  f.repo.members.set('member', { ...f.repo.getMember('member'), sessionId: 'session-2' });
  f.end(job);
  await f.flush();
  assert.equal(job.finished, false);
  assert.equal(f.message(job).status, 'pending');
  assert.equal(f.message(job).text, '');
  f.engine.abortJob(job, 'user');
  await f.flush();
  assert.equal(f.message(job).status, 'stopped');
  assert.equal(f.message(job).meta.lateDelivery, undefined);
});
