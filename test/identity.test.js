import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityService, IDENTITY_SERVICE_NAME, parentSessionIdOf } from '../host/identity.js';

/** Minimal repository double with the exact fields isCurrentMemberSession reads. */
export function identityFixture() {
  const groups = new Map([['group', { groupId: 'group', activeConversationId: 'conv-1' }]]);
  const conversations = new Map([['conv-1', { conversationId: 'conv-1', groupId: 'group' }]]);
  const members = new Map([['member', {
    membershipId: 'member', botId: 'bot', groupId: 'group',
    sessionId: 'session-bot', sessionConversationId: 'conv-1', previousSessionIds: ['session-old'],
  }]]);
  const bindings = new Map([['session-bot', {
    sessionId: 'session-bot', groupId: 'group', membershipId: 'member', botId: 'bot', conversationId: 'conv-1',
  }]]);
  const repo = {
    groups, conversations, members,
    getMember: id => members.get(id),
    activeConversation: groupId => conversations.get(groups.get(groupId)?.activeConversationId),
    sessionBindingFor: sessionId => bindings.get(sessionId),
  };
  const agents = new Map();
  const ctx = { agents: { get: id => agents.get(id) } };
  const pool = { memberForSession: sessionId => [...members.values()].find(member => member.sessionId === sessionId) };
  return { repo, agents, ctx, pool };
}

const childAgent = (id, parentSessionId, session = {}) => ({
  id,
  session: { header: { id, origin: 'subagent', parentSessionId }, ...session },
  ctx: {},
});

test('resolves the durable membership of a current Bot session', () => {
  const { repo, ctx, pool } = identityFixture();
  const identity = createIdentityService(ctx, { repo, pool });
  const snapshot = identity.resolve('session-bot');
  assert.deepEqual({ ...snapshot }, {
    version: 1,
    sessionId: 'session-bot',
    membershipId: 'member',
    botId: 'bot',
    groupId: 'group',
    conversationId: 'conv-1',
  });
  assert.equal(Object.isFrozen(snapshot), true);
});

test('never resolves a rotated session and reports it as a known Bot session', () => {
  const { repo, ctx, pool } = identityFixture();
  const identity = createIdentityService(ctx, { repo, pool });
  assert.equal(identity.resolve('session-old'), undefined);
  const diagnostic = identity.describe('session-old');
  assert.equal(diagnostic.knownBot, true);
  assert.equal(diagnostic.current, false);
  assert.equal(diagnostic.snapshot, undefined);
});

test('inherits the nearest Bot identity for a live native subagent', () => {
  const { repo, ctx, pool, agents } = identityFixture();
  const identity = createIdentityService(ctx, { repo, pool });
  agents.set('session-bot', childAgent('session-bot', undefined));
  agents.set('child-1', childAgent('child-1', 'session-bot'));
  const snapshot = identity.resolve('child-1');
  assert.equal(snapshot?.botId, 'bot');
  assert.equal(snapshot?.sessionId, 'child-1');
  assert.equal(snapshot?.inherited, true);
  assert.equal(snapshot?.rootSessionId, 'session-bot');
  assert.equal(Object.isFrozen(snapshot), true);
});

test('walks a bounded ancestry and refuses a parent cycle', () => {
  const { repo, ctx, pool, agents } = identityFixture();
  const identity = createIdentityService(ctx, { repo, pool });
  agents.set('child-1', childAgent('child-1', 'child-2'));
  agents.set('child-2', childAgent('child-2', 'child-1'));
  assert.equal(identity.resolve('child-1'), undefined);
  const deep = identity.resolve('child-1');
  assert.equal(deep, undefined);
});

test('returns nothing for an unknown session and for a service that is not ready', () => {
  const { repo, ctx, pool } = identityFixture();
  const identity = createIdentityService(ctx, { repo, pool });
  assert.equal(identity.resolve('unrelated'), undefined);
  assert.equal(identity.describe('unrelated').knownBot, false);
  const pending = createIdentityService(ctx, { repo: null, pool: null });
  assert.equal(pending.resolve('session-bot'), undefined);
  assert.equal(pending.describe('session-bot').ready, false);
});

test('reads the live service so identity appears only after Bot Team is ready', () => {
  const { repo, ctx, pool } = identityFixture();
  const service = { repo: null, pool: null };
  const identity = createIdentityService(ctx, () => service);
  assert.equal(identity.resolve('session-bot'), undefined);
  service.repo = repo;
  service.pool = pool;
  assert.equal(identity.resolve('session-bot')?.botId, 'bot');
});

test('exposes a stable service name and reads native parent pointers', () => {
  assert.equal(IDENTITY_SERVICE_NAME, 'botTeamIdentity');
  assert.equal(parentSessionIdOf({ session: { header: { parentSessionId: 'p' } } }), 'p');
  assert.equal(parentSessionIdOf({ session: { header: { parentSession: 'q' } } }), 'q');
  assert.equal(parentSessionIdOf({ session: { header: {} } }), undefined);
  assert.equal(parentSessionIdOf(undefined), undefined);
});
