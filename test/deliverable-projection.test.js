import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../host/engine.js';
import { resolveConfig } from '../host/util.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

/** Conversation-aware doubles plus a recording attachment store. */
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-team-deliverable-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'bot-team-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const groups = new Map([['group', { groupId: 'group', title: 'Group', nextSeq: 0, activeConversationId: 'conv-1' }]]);
  const conversations = new Map([['conv-1', { conversationId: 'conv-1', groupId: 'group', ordinal: 1, afterSeq: 0 }]]);
  const members = new Map([['member', { membershipId: 'member', botId: 'bot', groupId: 'group', sessionId: 'session-1', sessionConversationId: 'conv-1', lastSeenSeq: 0 }]]);
  const bots = new Map([['bot', { botId: 'bot', name: 'Tester', provider: 'mock', model: 'mock' }]]);
  const messages = new Map();
  const frames = []; const agents = new Map(); const saved = [];
  const repo = {
    groups, conversations, members, bots, messages,
    getGroup: id => groups.get(id), getMember: id => members.get(id), getBot: id => bots.get(id), getMessage: id => messages.get(id),
    getTask: () => undefined, getDiscussion: () => undefined, discussionsOf: () => [],
    activeConversation: gid => conversations.get(groups.get(gid)?.activeConversationId),
    conversationsOf: gid => [...conversations.values()].filter(conversation => conversation.groupId === gid),
    conversationFor(record) {
      if (!record) return undefined;
      const found = record.conversationId ? conversations.get(record.conversationId)
        : repo.conversationsOf(record.groupId).findLast(conversation => record.seq > conversation.afterSeq);
      return found?.groupId === record.groupId ? found : undefined;
    },
    sessionBindingFor: sessionId => ({ sessionId, groupId: 'group', conversationId: 'conv-1', membershipId: 'member', botId: 'bot' }),
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
  const attachments = {
    async saveFile({ data, name }) {
      const ref = { attachmentId: 'att-' + (saved.length + 1), name, bytes: data.byteLength };
      saved.push({ ...ref, data });
      return ref;
    },
    fileHostPath: ref => path.join(root, ref.name),
  };
  const ctx = { on: () => () => {}, get: name => (name === 'attachments' ? attachments : undefined), agents: { get: id => agents.get(id) } };
  function agent(sessionId) {
    if (!agents.has(sessionId)) agents.set(sessionId, {
      id: sessionId,
      session: { id: sessionId, seq: 0, header: { id: sessionId, cwd: root }, events: [], snapshotEvents() { return this.events; } },
      cancel() {},
      followup: async () => {},
    });
    return agents.get(sessionId);
  }
  agent('session-1');
  const pool = {
    attachClaimHandler: () => () => {}, owns: () => true,
    memberForSession: sessionId => [...members.values()].find(member => member.sessionId === sessionId),
    async ensure() { return agent('session-1'); },
    submit: (handle, input) => handle.followup(input),
  };
  const engine = new Engine({
    ctx, repo, pool, config: resolveConfig({ resultMode: 'final', ...options }),
    personas: { refresh: async () => {} }, logger: { warn() {} },
    taskHook: () => {}, bus: { emit: (groupId, frame) => frames.push({ groupId, ...structuredClone(frame) }) },
  });
  const f = {
    root, outside, repo, engine, frames, saved,
    async flush() { for (let index = 0; index < 40; index += 1) await tick(); },
    async post() {
      const result = engine.postHumanMessage({ groupId: 'group', text: 'REQUEST', mentions: ['member'] });
      await f.flush();
      return { ...result, job: engine.running.get('member') };
    },
    begin(job, turn = 1) {
      f.event(job, 'turn/start', { turn });
      engine.onInboxClaim({ agent: agents.get(job.sessionId), message: { id: job.execution.inputMessageId }, turn });
      f.event(job, 'user/message', { id: job.execution.inputMessageId, turn });
    },
    event(job, type, data) {
      const session = agents.get(job.sessionId).session;
      const event = { seq: session.seq++, type, data };
      session.events.push(event); engine.onSessionEvent(session, event); return event;
    },
    present(job, files) { f.event(job, 'deliverables/presented', { turn: job.turn, callId: 'call-1', files }); },
    message(job) { return repo.getMessage(job.placeholderId); },
    fileOf(relative) { return path.join(root, relative); },
    outsideFileOf(relative) { return path.join(outside, relative); },
  };
  t.after(async () => { await engine.dispose(); await f.flush(); });
  return f;
}

test('a presented workspace file becomes a native attachment on the reply', async t => {
  const f = await fixture(t);
  await writeFile(f.fileOf('report.md'), '# 结果\n');
  const { job } = await f.post();
  f.begin(job);
  f.present(job, [{ path: 'report.md' }]);
  await f.flush();
  const message = f.message(job);
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].name, 'report.md');
  assert.equal(message.attachments[0].bytes, 9);
  assert.equal(message.attachments[0].path, path.join(f.root, 'report.md'));
  assert.equal(f.frames.filter(frame => frame.type === 'message.updated').length, 1);
});

test('the same presented file is attached only once', async t => {
  const f = await fixture(t);
  await writeFile(f.fileOf('once.txt'), 'x');
  const { job } = await f.post();
  f.begin(job);
  f.present(job, [{ path: 'once.txt' }]);
  f.present(job, [{ path: 'once.txt' }]);
  await f.flush();
  assert.equal(f.message(job).attachments.length, 1);
  assert.equal(f.saved.length, 1);
});

test('files outside the Bot workspace are refused', async t => {
  const f = await fixture(t);
  await writeFile(f.outsideFileOf('secret.txt'), 'secret');
  const { job } = await f.post();
  f.begin(job);
  f.present(job, [{ path: f.outsideFileOf('secret.txt') }]);
  await f.flush();
  assert.equal(f.message(job).attachments.length, 0);
  assert.equal(f.saved.length, 0);
});

test('configured delivery roots extend the allowed set', async t => {
  const f = await fixture(t, { deliveryRoots: ['/tmp'] });
  const outside = await mkdtemp(path.join('/tmp', 'bot-team-extra-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'shared.txt'), 'ok');
  const { job } = await f.post();
  f.begin(job);
  f.present(job, [{ path: path.join(outside, 'shared.txt') }]);
  await f.flush();
  assert.equal(f.message(job).attachments.length, 1);
});

test('at most four files are projected and missing files do not fail the turn', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 6; index += 1) await writeFile(f.fileOf(`f${index}.txt`), String(index));
  const { job } = await f.post();
  f.begin(job);
  f.present(job, [
    { path: 'missing.txt' },
    ...[0, 1, 2, 3, 4, 5].map(index => ({ path: `f${index}.txt` })),
  ]);
  await f.flush();
  assert.equal(f.message(job).attachments.length, 4);
  assert.deepEqual(f.message(job).attachments.map(item => item.name), ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt']);
});
