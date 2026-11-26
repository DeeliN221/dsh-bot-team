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
  const bindings = new Map([['session-1', {
    sessionId: 'session-1', groupId: 'group', conversationId: 'conv-1', membershipId: 'member', botId: 'bot',
  }]]);
  const messages = new Map();
  const frames = []; const submissions = []; const hooks = []; const agents = new Map(); const warnings = [];
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
    sessionBindingFor: sessionId => bindings.get(sessionId),
    sessionBindingsOf: (gid, cid) => [...bindings.values()].filter(binding =>
      binding.groupId === gid && (!cid || binding.conversationId === cid)),
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
  const config = resolveConfig({ resultMode: options.resultMode });
  const makeEngine = () => new Engine({
    ctx, repo, pool, config,
    personas: { refresh: async () => {} }, logger: { warn: text => warnings.push(text) },
    taskHook: (...args) => hooks.push(args),
    bus: { emit: (groupId, frame) => frames.push({ groupId, ...structuredClone(frame) }) },
  });
  const engine = makeEngine();
  const reloaded = [];
  const f = {
    repo, engine, frames, submissions, hooks, agents, bindings, warnings,
    calls: { pumps: [], idles: [], after: [] },
    async flush() { for (let index = 0; index < 8; index += 1) await tick(); },
    async post(extra = {}) {
      const result = engine.postHumanMessage({ groupId: 'group', text: 'REQUEST', mentions: ['member'], ...extra });
      await f.flush();
      return { ...result, job: engine.running.get('member') };
    },
    message(job) { return repo.getMessage(job.placeholderId); },
    event(job, type, data) {
      return f.emit(job.sessionId, type, data);
    },
    emit(sessionId, type, data) {
      return f.emitOn(engine, sessionId, type, data);
    },
    emitOn(instance, sessionId, type, data) {
      const session = agents.get(sessionId).session;
      const event = { seq: session.seq++, type, data };
      session.events.push(event); instance.onSessionEvent(session, event); return event;
    },
    /** Simulate a plugin reload: fresh Engine over the same persisted repository. */
    reload() {
      const next = makeEngine();
      reloaded.push(next);
      return next;
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
  t.after(async () => {
    await engine.dispose();
    for (const instance of reloaded) await instance.dispose();
    await f.flush();
  });
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
    // A late settlement still releases the member for the new conversation's queue.
    assert.deepEqual(f.calls.pumps, ['group']);
    assert.deepEqual(f.calls.idles, ['group']);
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
  // A replayed receipt of the already settled turn is not new work.
  f.end(job);
  f.answer(job, 'DUPLICATE');
  f.event(job, 'turn/start', { turn: 1 });
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
    assert.deepEqual(f.calls.pumps, ['group']);
    assert.deepEqual(f.calls.after, []);
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

test('a late settlement releases the member queue for the new conversation', async t => {
  const f = fixture(t);
  const { job } = await f.post();
  f.begin(job);
  f.answer(job, 'OLD ANSWER');
  const newConversationId = f.switchConversation();
  f.engine.postHumanMessage({ groupId: 'group', text: 'NEW REQUEST', mentions: ['member'] });
  await f.flush();
  assert.equal(f.engine.queue.length, 1, 'the new request waits while the member is busy');
  f.end(job);
  await f.flush();
  assert.equal(job.state, 'done');
  assert.equal(f.engine.queue.length, 0, 'late settlement must not leave the new request queued forever');
  // The fixture keeps the member bound to the old conversation, so the queued
  // request is attempted and refused instead of executing against the new one.
  assert.equal(f.repo.getMessage(job.placeholderId).conversationId, 'conv-1');
  assert.equal(newConversationId !== 'conv-1', true);
});

test('historical projection delivers an outbox turn into its closed conversation', async t => {
  const f = fixture(t);
  const conversationId = f.switchConversation();
  const frameCount = f.frames.length;
  f.watch();
  f.emit('session-1', 'turn/start', { turn: 7 });
  await f.flush();
  const placeholder = f.repo.messagesOf('group').find(message => message.kind === 'native');
  assert.ok(placeholder, 'a historical turn must create its own reply');
  assert.equal(placeholder.conversationId, 'conv-1');
  assert.equal(placeholder.status, 'pending');
  assert.equal(f.repo.messagesOf('group').filter(message => message.conversationId === conversationId).length, 0);
  assert.ok(f.frames.slice(frameCount).some(frame => frame.type === 'message.added' && frame.message.messageId === placeholder.messageId));

  f.emit('session-1', 'assistant/message', { turn: 7, message: { content: [{ type: 'text', text: 'OUTBOX RESULT' }] } });
  f.emit('session-1', 'deliverables/presented', { turn: 7, files: [{ path: 'report.md' }] });
  f.emit('session-1', 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  await f.flush();
  const settled = f.repo.getMessage(placeholder.messageId);
  assert.equal(settled.status, 'done');
  assert.equal(settled.text, 'OUTBOX RESULT');
  assert.equal(settled.conversationId, 'conv-1');
  assert.equal(settled.meta.lateDelivery, true);
  assert.equal(settled.meta.historical, true);
  assert.equal(f.hooks.length, 0);
  assert.deepEqual(f.calls.pumps, [], 'a historical receipt must not pump the current queue');
  assert.deepEqual(f.calls.after, []);
  assert.ok(!f.frames.slice(frameCount).some(frame => frame.conversationId === conversationId));
  const count = f.repo.messages.size;

  // A replayed receipt of the same turn is not new work.
  f.emit('session-1', 'turn/start', { turn: 7 });
  f.emit('session-1', 'assistant/message', { turn: 7, message: { content: [{ type: 'text', text: 'OUTBOX RESULT' }] } });
  f.emit('session-1', 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  await f.flush();
  assert.equal(f.repo.messages.size, count);
  assert.equal(f.repo.getMessage(placeholder.messageId).text, 'OUTBOX RESULT');
});

test('historical projection refuses bindings that do not prove their group or bot', async t => {
  const f = fixture(t);
  f.switchConversation();
  const frameCount = f.frames.length;
  const binding = f.bindings.get('session-1');
  for (const tampered of [
    { ...binding, groupId: 'foreign-group' },
    { ...binding, botId: 'missing-bot' },
    { ...binding, conversationId: f.repo.getGroup('group').activeConversationId },
  ]) {
    f.bindings.set('session-1', tampered);
    f.emit('session-1', 'turn/start', { turn: 9 });
    await f.flush();
  }
  assert.equal(f.repo.messagesOf('group').length, 0);
  assert.equal(f.frames.length, frameCount);
});

test('a tampered binding blocks a late settlement write and broadcast', async t => {
  const f = fixture(t);
  const { job } = await f.post();
  f.begin(job);
  f.answer(job, 'SECRET ANSWER');
  const placeholderId = job.placeholderId;
  f.switchConversation();
  f.bindings.set('session-1', { ...f.bindings.get('session-1'), conversationId: 'conv-2' });
  f.end(job);
  await f.flush();
  assert.equal(job.finished, false, 'an unproven late event is not observed');
  f.engine.abortJob(job, 'user');
  await f.flush();
  const message = f.repo.getMessage(placeholderId);
  assert.equal(job.state, 'stopped');
  assert.equal(message.status, 'pending');
  assert.equal(message.text, '');
  assert.equal(f.frames.filter(frame => frame.type === 'message.updated').length, 0);
  assert.ok(f.warnings.some(text => /dropped reply settlement/.test(text)));
});

test('a tampered binding blocks a historical settlement write', async t => {
  const f = fixture(t);
  f.switchConversation();
  f.emit('session-1', 'turn/start', { turn: 11 });
  await f.flush();
  const job = f.engine.historicalBySession.get('session-1');
  assert.ok(job);
  f.bindings.set('session-1', { ...f.bindings.get('session-1'), botId: 'missing-bot' });
  f.engine.finishJob(job, 'done');
  await f.flush();
  const message = f.repo.getMessage(job.placeholderId);
  assert.equal(message.status, 'pending');
  assert.equal(f.frames.filter(frame => frame.type === 'message.updated').length, 0);
  assert.ok(f.warnings.some(text => /dropped reply settlement/.test(text)));
});

test('an outbox turn replayed after reload is delivered once and deduplicated', async t => {
  const f = fixture(t);
  f.switchConversation();
  f.emit('session-1', 'turn/start', { turn: 7 });
  f.emit('session-1', 'assistant/message', { turn: 7, message: { content: [{ type: 'text', text: 'OUTBOX RESULT' }] } });
  f.emit('session-1', 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  await f.flush();
  const placeholder = f.repo.messagesOf('group').find(message => message.kind === 'native');
  assert.equal(placeholder.status, 'done');
  assert.equal(placeholder.conversationId, 'conv-1');
  const count = f.repo.messages.size;

  // Plugin reload: the in-memory historical/settled maps are gone, only the
  // durable repository survives. The same receipt must not create new work.
  const next = f.reload();
  f.emitOn(next, 'session-1', 'turn/start', { turn: 7 });
  f.emitOn(next, 'session-1', 'assistant/message', { turn: 7, message: { content: [{ type: 'text', text: 'OUTBOX RESULT' }] } });
  f.emitOn(next, 'session-1', 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  await f.flush();
  assert.equal(f.repo.messages.size, count, 'reload replay must not add a reply');
  assert.equal(f.repo.getMessage(placeholder.messageId).text, 'OUTBOX RESULT');
  assert.equal(f.repo.messagesOf('group').filter(message => message.kind === 'native').length, 1);

  // A genuinely new receipt after reload still projects into the closed
  // conversation, proving the projection works (not merely refusing).
  f.emitOn(next, 'session-1', 'turn/start', { turn: 8 });
  f.emitOn(next, 'session-1', 'assistant/message', { turn: 8, message: { content: [{ type: 'text', text: 'SECOND RESULT' }] } });
  f.emitOn(next, 'session-1', 'turn/end', { turn: 8, reason: { kind: 'completed' } });
  await f.flush();
  const native = f.repo.messagesOf('group').filter(message => message.kind === 'native');
  assert.equal(native.length, 2);
  assert.equal(native.at(-1).conversationId, 'conv-1');
  assert.equal(native.at(-1).text, 'SECOND RESULT');
  assert.equal(native.at(-1).meta.lateDelivery, true);
  const afterSecond = f.repo.messages.size;
  f.emitOn(next, 'session-1', 'turn/start', { turn: 8 });
  f.emitOn(next, 'session-1', 'assistant/message', { turn: 8, message: { content: [{ type: 'text', text: 'SECOND RESULT' }] } });
  f.emitOn(next, 'session-1', 'turn/end', { turn: 8, reason: { kind: 'completed' } });
  await f.flush();
  assert.equal(f.repo.messages.size, afterSecond);
});

test('a reload in the middle of an outbox turn reuses the pending reply', async t => {
  const f = fixture(t);
  f.switchConversation();
  f.emit('session-1', 'turn/start', { turn: 7 });
  await f.flush();
  const pending = f.repo.messagesOf('group').filter(message => message.kind === 'native');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');

  const next = f.reload();
  f.emitOn(next, 'session-1', 'turn/start', { turn: 7 });
  f.emitOn(next, 'session-1', 'assistant/message', { turn: 7, message: { content: [{ type: 'text', text: 'RESUMED RESULT' }] } });
  f.emitOn(next, 'session-1', 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  await f.flush();
  const native = f.repo.messagesOf('group').filter(message => message.kind === 'native');
  assert.equal(native.length, 1, 'a pending placeholder is reused across reload');
  assert.equal(native[0].messageId, pending[0].messageId);
  assert.equal(native[0].status, 'done');
  assert.equal(native[0].text, 'RESUMED RESULT');
});

test('a new historical turn supersedes one that never settled', async t => {
  const f = fixture(t);
  f.switchConversation();
  f.emit('session-1', 'turn/start', { turn: 7 });
  await f.flush();
  f.emit('session-1', 'turn/start', { turn: 8 });
  f.emit('session-1', 'assistant/message', { turn: 8, message: { content: [{ type: 'text', text: 'NEWER RESULT' }] } });
  f.emit('session-1', 'turn/end', { turn: 8, reason: { kind: 'completed' } });
  await f.flush();
  const native = f.repo.messagesOf('group').filter(message => message.kind === 'native');
  assert.equal(native.length, 2);
  assert.equal(native[0].status, 'stopped');
  assert.equal(native[0].text, '');
  assert.equal(native[1].status, 'done');
  assert.equal(native[1].text, 'NEWER RESULT');
});

test('an owned cancel still settles after the member record is gone', async t => {
  const f = fixture(t);
  const { job } = await f.post();
  f.begin(job);
  f.answer(job, 'PARTIAL');
  // The binding survives the membership; the job persisted its botId at start.
  f.repo.members.delete('member');
  f.engine.abortJob(job, 'user');
  await f.flush();
  const message = f.repo.getMessage(job.placeholderId);
  assert.equal(job.state, 'stopped');
  assert.equal(message.status, 'stopped');
  assert.equal(message.error, '已停止');
});

test('reload mid-turn recovers via recoverNativeSessions without re-injecting turn/start', async t => {
  const f = fixture(t);
  f.switchConversation();
  f.emit('session-1', 'turn/start', { turn: 7 });
  await f.flush();
  const pending = f.repo.messagesOf('group').filter(message => message.kind === 'native');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');
  const originalJobId = pending[0].meta.execution.jobId;

  const next = f.reload();
  await next.recoverNativeSessions();
  // No synthetic turn/start is emitted — only the remaining assistant/message and turn/end!
  f.emitOn(next, 'session-1', 'assistant/message', { turn: 7, message: { content: [{ type: 'text', text: 'AUTO RECOVERED' }] } });
  f.emitOn(next, 'session-1', 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  await f.flush();
  const native = f.repo.messagesOf('group').filter(message => message.kind === 'native');
  assert.equal(native.length, 1);
  assert.equal(native[0].messageId, pending[0].messageId);
  assert.equal(native[0].meta.execution.jobId, originalJobId);
  assert.equal(native[0].status, 'done');
  assert.equal(native[0].text, 'AUTO RECOVERED');
});

test('downtime-completed historical turn is recovered via sessionQuery.observeSession and disposed', async t => {
  const f = fixture(t);
  // First record conv-1 turn 1 so maxRecordedTurn = 1
  const { job } = await f.post();
  f.begin(job, 1);
  f.answer(job, 'INITIAL');
  f.end(job, 1);
  await f.flush();
  f.switchConversation();

  // Simulate session-1 going cold (removed from live agents) and completing turn 2 during downtime
  f.agents.delete('session-1');
  let disposed = 0;
  f.repo.sessionBindings = f.bindings;
  const coldEvents = [
    { seq: 10, type: 'turn/start', data: { turn: 2 } },
    { seq: 11, type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'DOWNTIME OUTBOX' }] } } },
    { seq: 12, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  const next = f.reload();
  next.ctx = {
    ...next.ctx,
    get: name => (name === 'sessionQuery' ? {
      observeSession: async (id, opts) => {
        assert.equal(id, 'session-1');
        assert.equal(opts?.projectionMode, 'none');
        return {
          header: { id: 'session-1' },
          events: coldEvents,
          [Symbol.dispose]() { disposed += 1; },
        };
      },
    } : undefined),
  };
  await next.recoverNativeSessions();
  await f.flush();
  assert.equal(disposed, 1);
  const historical = f.repo.messagesOf('group').filter(m => m.meta?.historical === true);
  assert.equal(historical.length, 1);
  assert.equal(historical[0].status, 'done');
  assert.equal(historical[0].text, 'DOWNTIME OUTBOX');
  assert.equal(historical[0].conversationId, 'conv-1');
});

test('out-of-order or replayed older turn/start never stops a newer active historical turn', async t => {
  const f = fixture(t);
  f.switchConversation();
  f.emit('session-1', 'turn/start', { turn: 8 });
  await f.flush();
  // Replay older turn 7 start while turn 8 is running
  f.emit('session-1', 'turn/start', { turn: 7 });
  f.emit('session-1', 'assistant/message', { turn: 8, message: { content: [{ type: 'text', text: 'TURN 8 SURVIVED' }] } });
  f.emit('session-1', 'turn/end', { turn: 8, reason: { kind: 'completed' } });
  await f.flush();
  const native = f.repo.messagesOf('group').filter(message => message.kind === 'native');
  assert.equal(native.length, 1);
  assert.equal(native[0].status, 'done');
  assert.equal(native[0].text, 'TURN 8 SURVIVED');
});
