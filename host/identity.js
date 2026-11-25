/**
 * Read-only trusted identity for Bot Team sessions.
 *
 * Other Host plugins (for example a deployment policy plugin) must never infer
 * a Bot's role from a name, persona text, workspace path, or caller-provided
 * metadata. This service exposes the durable membership binding that Bot Team
 * itself already validates, so a consumer can authorize against `botId` while
 * the same group keeps sharing one workspace.
 *
 * The resolver is deliberately narrow: it returns a frozen identifier snapshot
 * or `undefined`, never mutable records, and it never accepts an identity from
 * the caller. Native subagent sessions inherit the Bot identity of their
 * nearest Bot ancestor so a delegated tool call stays under the same policy.
 */
import { isCurrentMemberSession } from './conversations.js';

/** Cordis service name consumers inject or `ctx.get`. */
export const IDENTITY_SERVICE_NAME = 'botTeamIdentity';

/** Bound the native ancestry walk; a deeper chain is not a Bot session. */
const MAX_ANCESTRY = 8;

const freeze = value => Object.freeze(value);

function snapshotOf(member, sessionId, extra) {
  return freeze({
    version: 1,
    sessionId,
    membershipId: member.membershipId,
    botId: member.botId,
    groupId: member.groupId,
    conversationId: member.sessionConversationId ?? null,
    ...extra,
  });
}

function membersOf(repo) {
  if (!repo?.members) return [];
  return typeof repo.members.values === 'function' ? [...repo.members.values()] : [];
}

/** The membership currently bound to `sessionId`, re-validated against the repo. */
function currentMemberFor(repo, pool, sessionId) {
  const candidate = pool?.memberForSession?.(sessionId);
  if (candidate && isCurrentMemberSession(repo, candidate, sessionId)) return candidate;
  for (const member of membersOf(repo)) {
    if (isCurrentMemberSession(repo, member, sessionId)) return member;
  }
  return undefined;
}

/** Durable parent pointer of a native subagent session header. */
export function parentSessionIdOf(agent) {
  const header = agent?.session?.header;
  if (!header || typeof header !== 'object') return undefined;
  for (const key of ['parentSessionId', 'parentSession']) {
    const value = header[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Build the identity service over one Bot Team instance.
 * @param ctx Host context (only `ctx.agents` is read).
 * @param service Bot Team service getter; `repo`/`pool` stay null until ready.
 */
export function createIdentityService(ctx, service) {
  const repoOf = () => {
    const current = typeof service === 'function' ? service() : service;
    return current?.repo ?? undefined;
  };
  const poolOf = () => {
    const current = typeof service === 'function' ? service() : service;
    return current?.pool ?? undefined;
  };

  /** Resolve one current Bot session, or a live native descendant of one. */
  function resolve(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    const repo = repoOf();
    if (!repo) return undefined;
    const pool = poolOf();
    const direct = currentMemberFor(repo, pool, sessionId);
    if (direct) return snapshotOf(direct, sessionId, {});
    // Descendants: only live agents carry a readable native ancestry. A closed
    // session has no pending execution to authorize, so refusing is safe.
    let agent = ctx?.agents?.get?.(sessionId);
    const visited = new Set([sessionId]);
    for (let depth = 0; agent && depth < MAX_ANCESTRY; depth += 1) {
      const parentId = parentSessionIdOf(agent);
      if (!parentId || visited.has(parentId)) return undefined;
      visited.add(parentId);
      const member = currentMemberFor(repo, pool, parentId);
      if (member) return snapshotOf(member, sessionId, { inherited: true, rootSessionId: parentId });
      agent = ctx?.agents?.get?.(parentId);
    }
    return undefined;
  }

  /**
   * Diagnose an unknown session: `knownBot` stays true for a rotated Bot
   * session so a consumer can fail closed instead of falling back to a
   * workspace policy that no longer represents the Bot identity.
   */
  function describe(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return freeze({ knownBot: false, current: false });
    }
    const repo = repoOf();
    if (!repo) return freeze({ knownBot: false, current: false, ready: false });
    const known = membersOf(repo).find(member => member.sessionId === sessionId
      || (Array.isArray(member.previousSessionIds) && member.previousSessionIds.includes(sessionId)));
    const snapshot = resolve(sessionId);
    if (snapshot) return freeze({ knownBot: true, current: true, snapshot });
    if (known) return freeze({ knownBot: true, current: false, snapshot: undefined });
    return freeze({ knownBot: false, current: false });
  }

  return Object.freeze({
    version: 1,
    resolve,
    describe,
  });
}
