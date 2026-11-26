import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityService, IDENTITY_SERVICE_NAME, isNativeSubagent, parentSessionIdOf } from '../host/identity.js';

/** Minimal repository double with the exact fields identity reads. */
export function identityFixture() {
  const groups = new Map([['group', { groupId: 'group', activeConversationId: 'conv-2' }]]);
  const conversations = new Map([
    ['conv-1', { conversationId: 'conv-1', groupId: 'group' }],
    ['conv-2', { conversationId: 'conv-2', groupId: 'group' }],
  ]);
  const members = new Map([['member', {
    membershipId: 'member', botId: 'bot', groupId: 'group', enabled: true,
    sessionId: 'session-bot', sessionConversationId: 'conv-2', previousSessionIds: ['session-old'],
  }]]);
  const bindings = new Map([
    ['session-bot', { sessionId: 'session-bot', groupId: 'group', membershipId: 'member', botId: 'bot', conversationId: 'conv-2' }],
    ['session-old', { sessionId: 'session-old', groupId: 'group', membershipId: 'member', botId: 'bot', conversationId: 'conv-1' }],
  ]);
  const repo = {
    groups, conversations, members,
    getMember: id => members.get(id),
    activeConversation: groupId => conversations.get(groups.get(groupId)?.activeConversationId),
    sessionBindingFor: sessionId => bindings.get(sessionId),
  };
  const agents = new Map();
  const listeners = [];
  const ctx = {
    agents: { get: id => agents.get(id) },
    on: (type, handler) => {
      listeners.push({ type, handler });
      return () => { const index = listeners.indexOf(handler); if (index >= 0) listeners.splice(index, 1); };
    },
    emitCreated: agent => { for (const item of [...listeners]) if (item.type === 'agent/created') item.handler({ agent }); },
  };
  const pool = { memberForSession: sessionId => [...members.values()].find(member => member.sessionId === sessionId) };
  return { repo, agents, ctx, pool, bindings, listeners };
}

const childAgent = (id, parentId) => ({
  id,
  parentAgent: { id: parentId },
  session: { header: { id, origin: 'subagent', parentSession: parentId } },
  ctx: {},
});

test('resolves the durable membership of the current Bot session as current', () => {
  const { repo, ctx, pool } = identityFixture();
  const identity = createIdentityService(ctx, { repo, pool });
  const snapshot = identity.resolve('session-bot');
  assert.deepEqual({ ...snapshot }, {
    version: 2,
    sessionId: 'session-bot',
    membershipId: 'member',
    botId: 'bot',
    groupId: 'group',
    conversationId: 'conv-2',
    current: true,
    historical: false,
  });
  assert.equal(Object.isFrozen(snapshot), true);
});

test('a rotated session keeps its original identity as historical, not current', () => {
  const { repo, ctx, pool } = identityFixture();
  const identity = createIdentityService(ctx, { repo, pool });
  const snapshot = identity.resolve('session-old');
  assert.equal(snapshot.botId, 'bot');
  assert.equal(snapshot.conversationId, 'conv-1');
  assert.equal(snapshot.current, false);
  assert.equal(snapshot.historical, true);
  const diagnostic = identity.describe('session-old');
  assert.equal(diagnostic.knownBot, true);
  assert.equal(diagnostic.current, false);
  assert.equal(diagnostic.historical, true);
});

test('a deleted member still reports historical Bot affiliation from the binding', () => {
  const { repo, ctx, pool } = identityFixture();
  repo.members.delete('member');
  const identity = createIdentityService(ctx, { repo, pool });
  const snapshot = identity.resolve('session-old');
  assert.equal(snapshot?.botId, 'bot');
  assert.equal(snapshot?.historical, true);
  assert.equal(identity.describe('session-old').knownBot, true);
});

test('a disabled member is not current but keeps the Bot identity', () => {
  const { repo, ctx, pool } = identityFixture();
  repo.members.set('member', { ...repo.members.get('member'), enabled: false });
  const identity = createIdentityService(ctx, { repo, pool });
  const snapshot = identity.resolve('session-bot');
  assert.equal(snapshot?.botId, 'bot');
  assert.equal(snapshot?.current, false);
  assert.equal(snapshot?.historical, true);
});

test('verified subagents inherit through a non-live intermediate ancestor', () => {
  const { repo, ctx, pool, agents } = identityFixture();
  const identity = createIdentityService(ctx, { repo, pool });
  agents.set('session-bot', { id: 'session-bot', session: { header: { id: 'session-bot', origin: 'subagent' } } });
  const first = childAgent('child-1', 'session-bot');
  agents.set('child-1', first);
  ctx.emitCreated(first);
  const second = childAgent('child-2', 'child-1');
  agents.set('child-2', second);
  ctx.emitCreated(second);
  // The middle agent may be released while the grandchild keeps running.
  agents.delete('child-1');
  const snapshot = identity.resolve('child-2');
  assert.equal(snapshot?.botId, 'bot');
  assert.equal(snapshot?.sessionId, 'child-2');
  assert.equal(snapshot?.inherited, true);
  assert.equal(snapshot?.rootSessionId, 'session-bot');
  assert.equal(snapshot?.current, true);
  identity.dispose();
});

test('a historical fork that only kept a parent field is not a Bot child', () => {
  const { repo, ctx, pool, agents } = identityFixture();
  const identity = createIdentityService(ctx, { repo, pool });
  const fork = { id: 'fork-1', session: { header: { id: 'fork-1', origin: 'subagent', parentSession: 'session-bot' } } };
  agents.set('fork-1', fork);
  ctx.emitCreated(fork);
  assert.equal(identity.resolve('fork-1'), undefined);
  assert.equal(identity.describe('fork-1').knownBot, false);
  identity.dispose();
});

test('returns nothing for an unknown session and reports a not-ready service', () => {
  const { repo, ctx, pool } = identityFixture();
  const identity = createIdentityService(ctx, { repo, pool });
  assert.equal(identity.resolve('unrelated'), undefined);
  assert.equal(identity.describe('unrelated').knownBot, false);
  const pending = createIdentityService(ctx, { repo: null, pool: null });
  assert.equal(pending.resolve('session-bot'), undefined);
  assert.equal(pending.describe('session-bot').ready, false);
  pending.dispose();
});

test('reads the live service so identity appears only after Bot Team is ready', () => {
  const { repo, ctx, pool } = identityFixture();
  const service = { repo: null, pool: null };
  const identity = createIdentityService(ctx, () => service);
  assert.equal(identity.resolve('session-bot'), undefined);
  service.repo = repo;
  service.pool = pool;
  assert.equal(identity.resolve('session-bot')?.botId, 'bot');
  identity.dispose();
});

test('exposes the stable service name and validates creation edges', () => {
  assert.equal(IDENTITY_SERVICE_NAME, 'botTeamIdentity');
  assert.equal(parentSessionIdOf({ session: { header: { parentSession: 'p' } } }), 'p');
  assert.equal(parentSessionIdOf({ session: { header: { parentSessionId: 'q' } } }), 'q');
  assert.equal(parentSessionIdOf({ session: { header: {} } }), undefined);
  assert.equal(isNativeSubagent({ parentAgent: {}, session: { header: { origin: 'subagent' } } }), true);
  assert.equal(isNativeSubagent({ session: { header: { origin: 'subagent', parentSession: 'p' } } }), false);
  assert.equal(isNativeSubagent(undefined), false);
});

test('real DSH 0.2.3 subagent without parentAgent inherits via subagent/start and rootOf', async () => {
  const { repo, ctx, pool, agents, listeners } = identityFixture();
  const rootAgent = { id: 'session-bot', session: { header: { id: 'session-bot', origin: 'subagent' } } };
  agents.set('session-bot', rootAgent);
  const child1 = { id: 'child-sdk-1', session: { header: { id: 'child-sdk-1', origin: 'subagent', parentSession: 'session-bot', delegationDepth: 1 } } };
  const child2 = { id: 'child-sdk-2', session: { header: { id: 'child-sdk-2', origin: 'subagent', parentSession: 'child-sdk-1', delegationDepth: 2 } } };
  const subagents = {
    rootOf: agent => (agent.id === 'child-sdk-2' ? rootAgent : agent),
    listDescendants: async rootId => (rootId === 'session-bot' ? { children: [{ id: 'child-cold-3' }] } : { children: [] }),
  };
  ctx.get = name => (name === 'subagents' ? subagents : undefined);
  const identity = createIdentityService(ctx, { repo, pool, isReady: true });
  // Emit native subagent/start lifecycle event (no parentAgent on child!)
  for (const item of [...listeners]) {
    if (item.type === 'subagent/start') item.handler({ runId: 'run-1', provider: 'spawn', parentSessionId: 'session-bot', id: 'child-sdk-1', local: true });
  }
  assert.equal(identity.resolve('child-sdk-1')?.botId, 'bot');
  assert.equal(identity.resolve('child-sdk-1')?.inherited, true);
  assert.equal(identity.resolve('child-sdk-1')?.rootSessionId, 'session-bot');
  // Grandchild resolved via ctx.subagents.rootOf without live intermediate parent
  agents.set('child-sdk-2', child2);
  assert.equal(identity.resolve('child-sdk-2')?.botId, 'bot');
  assert.equal(identity.resolve('child-sdk-2')?.rootSessionId, 'session-bot');
  // Cold descendant warmed via ctx.subagents.listDescendants across reload
  await identity.warmLineage();
  assert.equal(identity.resolve('child-cold-3')?.botId, 'bot');
  assert.equal(identity.resolve('child-cold-3')?.rootSessionId, 'session-bot');
  // Forged child absent from live parent subagentCatalog is rejected
  rootAgent.projections = { values: { subagentCatalog: [{ id: 'child-sdk-1' }] } };
  const forged = { id: 'forged-1', session: { header: { id: 'forged-1', origin: 'subagent', parentSession: 'session-bot', delegationDepth: 1 } } };
  agents.set('forged-1', forged);
  ctx.emitCreated(forged);
  assert.equal(identity.resolve('forged-1'), undefined);
  identity.dispose();
});

test('conflicting member binding is rejected instead of downgraded to historical', () => {
  const { repo, ctx, pool, bindings } = identityFixture();
  // Member still points at session-bot (bot="bot", conv="conv-2"), but binding names another bot
  bindings.set('session-bot', {
    sessionId: 'session-bot', groupId: 'group', membershipId: 'member', botId: 'other-bot', conversationId: 'conv-2',
  });
  const identity = createIdentityService(ctx, { repo, pool, isReady: true });
  assert.equal(identity.resolve('session-bot'), undefined);
  const diag = identity.describe('session-bot');
  assert.equal(diag.knownBot, true);
  assert.equal(diag.conflict, true);
  assert.equal(diag.historical, false);
  assert.equal(diag.ready, true);
  identity.dispose();
});

test('normal /new rotation where member still holds old session matching binding remains valid historical', () => {
  const { repo, ctx, pool, bindings } = identityFixture();
  // Group activeConversationId is conv-2, member still points at session-old / conv-1 matching binding
  repo.members.set('member', {
    membershipId: 'member', botId: 'bot', groupId: 'group', enabled: true,
    sessionId: 'session-old', sessionConversationId: 'conv-1', previousSessionIds: [],
  });
  const identity = createIdentityService(ctx, { repo, pool, isReady: true });
  const snap = identity.resolve('session-old');
  assert.equal(snap?.botId, 'bot');
  assert.equal(snap?.current, false);
  assert.equal(snap?.historical, true);
  assert.equal(identity.describe('session-old').conflict, undefined);
  identity.dispose();
});

test('identity stays unready while BotTeamService isReady is false even if repo exists', () => {
  const { repo, ctx, pool } = identityFixture();
  const svc = { repo, pool, isReady: false };
  const identity = createIdentityService(ctx, () => svc);
  assert.equal(identity.resolve('session-bot'), undefined);
  assert.equal(identity.describe('session-bot').ready, false);
  svc.isReady = true;
  assert.equal(identity.resolve('session-bot')?.botId, 'bot');
  assert.equal(identity.describe('session-bot').ready, true);
  identity.dispose();
});
