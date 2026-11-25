/**
 * Read-only trusted identity for Bot Team sessions.
 *
 * Other Host plugins (for example a deployment policy plugin) must never infer
 * a Bot's role from a name, persona text, workspace path, or caller-provided
 * metadata. This service exposes the durable membership binding that Bot Team
 * itself already validates, so a consumer can authorize against `botId` while
 * the same group keeps sharing one workspace.
 *
 * Three states are reported explicitly:
 *   - current: the live member session of the active conversation;
 *   - historical: a durable session binding whose conversation, membership or
 *     member has since rotated away — it keeps the original Bot identity so a
 *     late outbox reply still runs under its own role, but it is NOT eligibility
 *     to start new work;
 *   - disabled: the member still exists but is switched off; identity is kept,
 *     `current` is false.
 *
 * A snapshot is always frozen identifiers, never mutable records, and the
 * caller can never submit an identity. Native subagents inherit the identity of
 * their nearest Bot ancestor only when the verified subagent manager created
 * them (`agent.parentAgent`); a historical fork that merely kept a parent field
 * is not treated as a Bot child.
 */
import { isCurrentMemberSession } from './conversations.js';

/** Cordis service name consumers inject or `ctx.get`. */
export const IDENTITY_SERVICE_NAME = 'botTeamIdentity';

/** Bound ancestry walks; a deeper chain is not a Bot session. */
const MAX_ANCESTRY = 8;

const freeze = value => Object.freeze(value);

const text = value => (typeof value === 'string' && value.length > 0 ? value : undefined);

function snapshotOf({ sessionId, membershipId, botId, groupId, conversationId, current, historical, inherited, rootSessionId }) {
  return freeze({
    version: 2,
    sessionId,
    membershipId,
    botId,
    groupId,
    conversationId,
    current,
    historical,
    ...(inherited ? { inherited: true, rootSessionId } : {}),
  });
}

function membersOf(repo) {
  if (!repo?.members) return [];
  return typeof repo.members.values === 'function' ? [...repo.members.values()] : [];
}

/** The membership currently bound to `sessionId`, re-validated against the repo. */
function currentMemberFor(repo, pool, sessionId) {
  const candidate = pool?.memberForSession?.(sessionId);
  if (candidate && candidate.enabled !== false && isCurrentMemberSession(repo, candidate, sessionId)) return candidate;
  for (const member of membersOf(repo)) {
    if (member.enabled === false) continue;
    if (isCurrentMemberSession(repo, member, sessionId)) return member;
  }
  return undefined;
}

function bindingOf(repo, sessionId) {
  if (typeof repo?.sessionBindingFor !== 'function') return undefined;
  let binding;
  try { binding = repo.sessionBindingFor(sessionId); }
  catch { return undefined; }
  if (!binding || !text(binding.sessionId) || !text(binding.groupId) || !text(binding.membershipId)
    || !text(binding.botId) || !text(binding.conversationId)) return undefined;
  if (binding.sessionId !== sessionId) return undefined;
  return binding;
}

/** Durable parent pointer of a native subagent session header. */
export function parentSessionIdOf(agent) {
  const header = agent?.session?.header;
  if (!header || typeof header !== 'object') return undefined;
  for (const key of ['parentSession', 'parentSessionId']) {
    const value = header[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * A native subagent proves its creation edge with a live parent Agent. A plain
 * historical fork may keep `parentSession` but has no creating Agent.
 * @param agent candidate Agent object from the Host catalog.
 * @returns whether this Agent was created by the native subagent manager.
 */
export function isNativeSubagent(agent) {
  if (!agent || !agent.parentAgent) return false;
  return agent.session?.header?.origin === 'subagent';
}

/**
 * Build the identity service over one Bot Team instance.
 * @param ctx Host context (reads `ctx.agents` and registers Agent catalog hooks).
 * @param service Bot Team service getter; `repo`/`pool` stay null until ready.
 */
export function createIdentityService(ctx, service) {
  const repoOf = () => (typeof service === 'function' ? service() : service)?.repo ?? undefined;
  const poolOf = () => (typeof service === 'function' ? service() : service)?.pool ?? undefined;
  /** Verified creation lineage: child session id -> Bot root session id. */
  const lineage = new Map();
  const disposes = [];

  function remember(agent) {
    if (!agent || !isNativeSubagent(agent)) return;
    const childId = agent.id;
    const parentId = parentSessionIdOf(agent);
    if (!childId || !parentId || lineage.has(childId)) return;
    if (lineage.has(parentId)) lineage.set(childId, lineage.get(parentId));
    else {
      const repo = repoOf();
      const root = bindingOf(repo, parentId) ? parentId
        : membersOf(repo).some(member => member.sessionId === parentId) ? parentId : undefined;
      if (root) lineage.set(childId, root);
    }
  }

  if (typeof ctx?.on === 'function') {
    // Catalog events cover subagents created after us and before `ready`.
    const offCreated = ctx.on('agent/created', ({ agent }) => remember(agent), { global: true });
    if (typeof offCreated === 'function') disposes.push(offCreated);
  }

  /** Current or durable-historical identity of one exact session. */
  function direct(sessionId) {
    const repo = repoOf();
    if (!repo) return undefined;
    const member = currentMemberFor(repo, poolOf(), sessionId);
    if (member) {
      return snapshotOf({
        sessionId,
        membershipId: member.membershipId,
        botId: member.botId,
        groupId: member.groupId,
        conversationId: member.sessionConversationId ?? bindingOf(repo, sessionId)?.conversationId,
        current: true,
        historical: false,
      });
    }
    const binding = bindingOf(repo, sessionId);
    if (!binding) return undefined;
    return snapshotOf({
      sessionId,
      membershipId: binding.membershipId,
      botId: binding.botId,
      groupId: binding.groupId,
      conversationId: binding.conversationId,
      current: false,
      historical: true,
    });
  }

  /** Resolve one Bot session, a historical binding, or a verified descendant. */
  function resolve(sessionId) {
    if (!text(sessionId)) return undefined;
    const own = direct(sessionId);
    if (own) return own;
    const rootId = lineage.get(sessionId);
    if (!rootId) return undefined;
    const root = direct(rootId);
    if (!root) return undefined;
    return snapshotOf({
      sessionId,
      membershipId: root.membershipId,
      botId: root.botId,
      groupId: root.groupId,
      conversationId: root.conversationId,
      current: root.current,
      historical: root.historical,
      inherited: true,
      rootSessionId: rootId,
    });
  }

  /**
   * Diagnose an unknown session. `knownBot` stays true for a rotated Bot
   * session or deleted member so a consumer can fail closed instead of falling
   * back to a workspace policy that no longer represents the Bot identity.
   */
  function describe(sessionId) {
    if (!text(sessionId)) return freeze({ knownBot: false, current: false, historical: false });
    const repo = repoOf();
    if (!repo) return freeze({ knownBot: false, current: false, historical: false, ready: false });
    const snapshot = resolve(sessionId);
    if (snapshot) {
      return freeze({ knownBot: true, current: snapshot.current, historical: snapshot.historical, snapshot });
    }
    const known = bindingOf(repo, sessionId) !== undefined
      || lineage.has(sessionId)
      || membersOf(repo).some(member => member.sessionId === sessionId
        || (Array.isArray(member.previousSessionIds) && member.previousSessionIds.includes(sessionId)));
    return freeze({ knownBot: known, current: false, historical: known });
  }

  return Object.freeze({
    version: 2,
    resolve,
    describe,
    /** Release catalog hooks; called by the plugin effect. */
    dispose() {
      for (const dispose of disposes.splice(0)) {
        try { dispose(); } catch { /* noop */ }
      }
      lineage.clear();
    },
  });
}
