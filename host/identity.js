/**
 * Read-only trusted identity for Bot Team sessions.
 *
 * Other Host plugins (for example a deployment policy plugin) must never infer
 * a Bot's role from a name, persona text, workspace path, or caller-provided
 * metadata. This service exposes the durable membership binding that Bot Team
 * itself already validates, so a consumer can authorize against `botId` while
 * the same group keeps sharing one workspace.
 *
 * Explicit states:
 *   - current: the live member session of the active conversation;
 *   - historical: a durable session binding whose conversation, membership or
 *     member has since rotated away (or whose member is disabled) — it keeps
 *     the original Bot identity so a late outbox reply still runs under its own
 *     role, but it is NOT eligibility to start new work;
 *   - conflict: a session still referenced by a live member whose durable
 *     binding disagrees with that member (or referenced by multiple members).
 *     Conflicts are never downgraded to historical authorization; `resolve`
 *     returns `undefined` and `describe` reports `conflict: true` so consumers
 *     fail closed.
 *
 * Native subagents inherit the identity of their nearest Bot ancestor through
 * real DSH 0.2.3 runtime contracts (`subagent/start` lifecycle events,
 * `ctx.subagents.rootOf`, parent `subagentCatalog` / `listDescendants`, and
 * durable `origin: 'subagent'` + `delegationDepth >= 1` headers). An ordinary
 * historical fork (`origin !== 'subagent'`) that merely retained `parentSession`
 * is never treated as a Bot child.
 */
import { isCurrentMemberSession } from './conversations.js';

/** Cordis service name consumers inject or `ctx.get`. */
export const IDENTITY_SERVICE_NAME = 'botTeamIdentity';

/** Bound ancestry walks; a deeper chain is not a Bot session. */
const MAX_ANCESTRY = 8;
/** Bound the verified-lineage cache so long-running hosts do not grow forever. */
const MAX_LINEAGE = 512;

const freeze = value => Object.freeze(value);

const text = value => (typeof value === 'string' && value.length > 0 ? value : undefined);

function snapshotOf({
  sessionId, membershipId, botId, groupId, conversationId,
  current, historical, disabled, inherited, rootSessionId,
}) {
  return freeze({
    version: 2,
    sessionId,
    membershipId,
    botId,
    groupId,
    conversationId,
    current,
    historical,
    ...(disabled ? { disabled: true } : {}),
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

/**
 * Detect whether `sessionId` is currently referenced by one or more members
 * whose identity/conversation mapping conflicts with its persisted binding.
 *
 * A legitimate `/new` rotation leaves `member.sessionId` pointing at the old
 * session with `member.sessionConversationId === binding.conversationId` while
 * `group.activeConversationId` has moved on — that matches on every field and
 * is NOT a conflict.
 */
function hasBindingConflict(repo, sessionId, binding) {
  const refs = membersOf(repo).filter(member => member && member.sessionId === sessionId);
  if (refs.length === 0) return false;
  if (refs.length > 1) return true;
  const member = refs[0];
  if (!binding) {
    // If a member points at this session without any binding under a migrated
    // group, we cannot trust a historical fallback either.
    const group = repo?.getGroup?.(member.groupId) ?? repo?.groups?.get?.(member.groupId);
    return Boolean(group?.activeConversationId);
  }
  if (binding.groupId !== member.groupId) return true;
  if (binding.membershipId !== member.membershipId) return true;
  if (binding.botId !== member.botId) return true;
  if (text(member.sessionConversationId) && binding.conversationId !== member.sessionConversationId) return true;
  return false;
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
 * Optional host-projected creation catalog on a live parent Agent.
 *
 * The 0.2.3 `Agent` contract exposes only `id`; `Session.projections` is private
 * and the real direct-child catalog is readable only through the asynchronous
 * `sessionQuery.observeSession(id).projections.values.subagentCatalog` (the
 * SDK's own `listChildren`). This synchronous hook therefore stays for hosts or
 * test doubles that project a catalog themselves, and returns `null` on the
 * real runtime, where verified lineage comes from `subagent/start`,
 * `ctx.subagents.rootOf`, and the factory-set durable `origin`/`delegationDepth`.
 */
function catalogContainsChild(parentAgent, childId) {
  const catalog = parentAgent?.projections?.values?.subagentCatalog;
  if (!Array.isArray(catalog)) return null; // catalog unavailable
  return catalog.some(entry => entry && entry.id === childId);
}

/**
 * Verify that an Agent is a real native subagent child (not an ordinary
 * historical fork that merely retained `parentSession`).
 *
 * In DSH 0.2.3, `ReactLoopAgent` exposes only `id`: neither `parentAgent` nor a
 * public `projections` catalog exists. Creation edges are proven by
 * `header.origin === 'subagent'` together with `ctx.subagents.rootOf`, the
 * factory-set durable `delegationDepth >= 1` / `parentSession` metadata, or (in
 * legacy test doubles) `agent.parentAgent` or a projected `subagentCatalog`.
 */
export function isNativeSubagent(agent, ctx) {
  if (!agent) return false;
  const header = agent.session?.header;
  if (!header || header.origin !== 'subagent') return false;
  if (agent.parentAgent) return true;
  const parentId = parentSessionIdOf(agent);
  if (!parentId) return false;
  const subagents = ctx?.get?.('subagents');
  if (typeof subagents?.rootOf === 'function') {
    try {
      const root = subagents.rootOf(agent);
      if (root && text(root.id) && root.id !== agent.id) return true;
    } catch { /* manager may not own this test/detached agent; check durable proofs */ }
  }
  const parent = ctx?.agents?.get?.(parentId);
  const inCatalog = catalogContainsChild(parent, agent.id);
  if (inCatalog === true) return true;
  if (inCatalog === false) return false; // parent is live with a catalog and child is absent
  if (Number.isSafeInteger(header.delegationDepth) && header.delegationDepth >= 1) return true;
  return Boolean(agent.parentAgent);
}

/**
 * Build the identity service over one Bot Team instance.
 * @param ctx Host context (reads `ctx.agents`, `ctx.subagents`, and registers lifecycle hooks).
 * @param service Bot Team service getter; `repo`/`pool` stay unavailable until ready.
 */
export function createIdentityService(ctx, service) {
  const svcOf = () => (typeof service === 'function' ? service() : service);
  const isReady = () => {
    const svc = svcOf();
    if (!svc?.repo) return false;
    return svc.isReady === undefined ? true : svc.isReady === true;
  };
  const repoOf = () => (isReady() ? svcOf()?.repo : undefined);
  const poolOf = () => (isReady() ? svcOf()?.pool : undefined);
  /** Verified creation lineage: child session id -> Bot root session id. */
  const lineage = new Map();
  /** Raw verified parent edges captured before `ready` so startup can resolve them. */
  const pendingEdges = new Map();
  const disposes = [];

  function setLineage(childId, rootId) {
    if (!text(childId) || !text(rootId) || childId === rootId) return;
    if (lineage.has(childId)) {
      lineage.delete(childId);
    } else if (lineage.size >= MAX_LINEAGE) {
      const oldest = lineage.keys().next();
      if (!oldest.done) lineage.delete(oldest.value);
    }
    lineage.set(childId, rootId);
  }

  function setPendingEdge(childId, parentId) {
    if (!text(childId) || !text(parentId) || childId === parentId) return;
    if (pendingEdges.has(childId)) pendingEdges.delete(childId);
    else if (pendingEdges.size >= MAX_LINEAGE) {
      const oldest = pendingEdges.keys().next();
      if (!oldest.done) pendingEdges.delete(oldest.value);
    }
    pendingEdges.set(childId, parentId);
  }

  function isKnownBotRoot(repo, sessionId) {
    if (!repo || !text(sessionId)) return false;
    if (bindingOf(repo, sessionId)) return true;
    return membersOf(repo).some(member => member.sessionId === sessionId
      || (Array.isArray(member.previousSessionIds) && member.previousSessionIds.includes(sessionId)));
  }

  function resolveRootFromParent(parentId) {
    if (!text(parentId)) return undefined;
    if (lineage.has(parentId)) return lineage.get(parentId);
    const repo = repoOf();
    if (isKnownBotRoot(repo, parentId)) return parentId;
    // Walk pendingEdges recorded before ready (bounded against cycles).
    let cursor = parentId;
    const seen = new Set([cursor]);
    for (let depth = 0; depth < MAX_ANCESTRY; depth += 1) {
      const next = pendingEdges.get(cursor);
      if (!next || seen.has(next)) break;
      seen.add(next);
      if (lineage.has(next)) return lineage.get(next);
      if (isKnownBotRoot(repo, next)) return next;
      cursor = next;
    }
    return undefined;
  }

  function rememberEdge(childId, parentId) {
    if (!text(childId) || !text(parentId) || childId === parentId) return;
    setPendingEdge(childId, parentId);
    const root = resolveRootFromParent(parentId);
    if (root) setLineage(childId, root);
  }

  function remember(agent) {
    if (!agent || !isNativeSubagent(agent, ctx)) return;
    const childId = text(agent.id);
    const parentId = parentSessionIdOf(agent);
    if (!childId || !parentId) return;
    // If the native subagent runtime already knows the exact root, record it.
    const subagents = ctx?.get?.('subagents');
    if (typeof subagents?.rootOf === 'function') {
      try {
        const root = subagents.rootOf(agent);
        if (root && text(root.id) && root.id !== childId) {
          rememberEdge(childId, root.id);
          return;
        }
      } catch { /* fall back to direct parent edge */ }
    }
    rememberEdge(childId, parentId);
  }

  if (typeof ctx?.on === 'function') {
    // Native DSH 0.2.3 subagent lifecycle event: emitted with verified parentSessionId
    // for every spawned or cold-resumed local/external subagent run.
    const offSubagentStart = ctx.on('subagent/start', (info) => {
      if (info && text(info.id) && text(info.parentSessionId)) {
        rememberEdge(info.id, info.parentSessionId);
      }
    }, { global: true });
    if (typeof offSubagentStart === 'function') disposes.push(offSubagentStart);

    // Catalog events cover subagents created after us and before `ready`.
    const offCreated = ctx.on('agent/created', ({ agent }) => remember(agent), { global: true });
    if (typeof offCreated === 'function') disposes.push(offCreated);
  }

  /**
   * Populate verified descendant lineage from durable parent catalogs via
   * `ctx.subagents.listDescendants` (supports non-resident intermediate
   * ancestors and plugin reloads) plus any already-live agents.
   */
  async function warmLineage() {
    const svc = svcOf();
    const repo = svc?.repo;
    if (!repo) return;
    // Resolve any edges captured before ready.
    for (const [childId, parentId] of pendingEdges.entries()) {
      const root = resolveRootFromParent(parentId);
      if (root) setLineage(childId, root);
    }
    // Inspect already-live agents. The real 0.2.3 registry exposes `list()`;
    // a Map-like double may expose only `values()`.
    const registry = ctx?.agents;
    const liveAgents = typeof registry?.list === 'function' ? registry.list()
      : typeof registry?.values === 'function' ? [...registry.values()] : [];
    for (const agent of Array.isArray(liveAgents) ? liveAgents : []) remember(agent);

    const subagents = ctx?.get?.('subagents');
    if (typeof subagents?.listDescendants !== 'function') return;
    const roots = new Set();
    for (const binding of repo.sessionBindings?.values?.() || []) {
      if (text(binding?.sessionId)) roots.add(binding.sessionId);
    }
    for (const member of membersOf(repo)) {
      if (text(member.sessionId)) roots.add(member.sessionId);
      if (Array.isArray(member.previousSessionIds)) {
        for (const id of member.previousSessionIds) if (text(id)) roots.add(id);
      }
    }
    for (const rootSessionId of roots) {
      try {
        const listed = await subagents.listDescendants(rootSessionId);
        // Real 0.2.3 `SubagentRuntime.listDescendants(rootId)` resolves a flat
        // array of `{ kind: 'child'|'diagnostic', id, parentId, depth }`; only a
        // legacy double wrapped it as `{ children }`. Every returned row is a
        // proven catalog descendant of the Bot root, diagnostics included.
        const entries = Array.isArray(listed) ? listed
          : Array.isArray(listed?.children) ? listed.children : [];
        for (const child of entries) {
          if (text(child?.id)) setLineage(child.id, rootSessionId);
        }
      } catch {
        /* cold or missing root session has no readable catalog */
      }
    }
  }

  /** Current or durable-historical identity of one exact session. */
  function direct(sessionId) {
    const repo = repoOf();
    if (!repo) return undefined;
    const binding = bindingOf(repo, sessionId);
    if (hasBindingConflict(repo, sessionId, binding)) return undefined;
    const member = currentMemberFor(repo, poolOf(), sessionId);
    if (member) {
      return snapshotOf({
        sessionId,
        membershipId: member.membershipId,
        botId: member.botId,
        groupId: member.groupId,
        conversationId: member.sessionConversationId ?? binding?.conversationId,
        current: true,
        historical: false,
      });
    }
    if (!binding) return undefined;
    const disabledMember = membersOf(repo).find(item => item.sessionId === sessionId && item.enabled === false);
    return snapshotOf({
      sessionId,
      membershipId: binding.membershipId,
      botId: binding.botId,
      groupId: binding.groupId,
      conversationId: binding.conversationId,
      current: false,
      historical: true,
      disabled: Boolean(disabledMember),
    });
  }

  /** Walk live runtime/header ancestry for a verified subagent not yet cached. */
  function resolveLiveLineageRoot(sessionId) {
    if (lineage.has(sessionId)) return lineage.get(sessionId);
    const fromPending = resolveRootFromParent(pendingEdges.get(sessionId));
    if (fromPending) {
      setLineage(sessionId, fromPending);
      return fromPending;
    }
    const agent = ctx?.agents?.get?.(sessionId);
    if (!agent || !isNativeSubagent(agent, ctx)) return undefined;
    const subagents = ctx?.get?.('subagents');
    if (typeof subagents?.rootOf === 'function') {
      try {
        const root = subagents.rootOf(agent);
        if (root && text(root.id) && root.id !== sessionId) {
          const repo = repoOf();
          if (isKnownBotRoot(repo, root.id)) {
            setLineage(sessionId, root.id);
            return root.id;
          }
          return undefined;
        }
      } catch { /* fall through to bounded parent walk */ }
    }
    let current = agent;
    const seen = new Set([sessionId]);
    for (let depth = 0; depth < MAX_ANCESTRY; depth += 1) {
      if (!isNativeSubagent(current, ctx)) return undefined;
      const parentId = parentSessionIdOf(current);
      if (!parentId || seen.has(parentId)) return undefined;
      seen.add(parentId);
      const knownRoot = resolveRootFromParent(parentId);
      if (knownRoot) {
        setLineage(sessionId, knownRoot);
        return knownRoot;
      }
      const parent = ctx?.agents?.get?.(parentId);
      if (!parent) return undefined;
      current = parent;
    }
    return undefined;
  }

  /** Resolve one Bot session, a historical binding, or a verified descendant. */
  function resolve(sessionId) {
    if (!text(sessionId)) return undefined;
    const repo = repoOf();
    if (!repo) return undefined;
    const own = direct(sessionId);
    if (own) return own;
    if (hasBindingConflict(repo, sessionId, bindingOf(repo, sessionId))) return undefined;
    const rootId = resolveLiveLineageRoot(sessionId);
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
      disabled: root.disabled === true,
      inherited: true,
      rootSessionId: rootId,
    });
  }

  /**
   * Diagnose an unknown session. `knownBot` stays true for a rotated Bot
   * session, deleted member, or conflicting member binding so a consumer can
   * fail closed instead of falling back to a shared workspace policy.
   */
  function describe(sessionId) {
    if (!text(sessionId)) return freeze({ knownBot: false, current: false, historical: false, ready: isReady() });
    const repo = repoOf();
    if (!repo) return freeze({ knownBot: false, current: false, historical: false, ready: false });
    const binding = bindingOf(repo, sessionId);
    if (hasBindingConflict(repo, sessionId, binding)) {
      return freeze({ knownBot: true, current: false, historical: false, conflict: true, ready: true });
    }
    const snapshot = resolve(sessionId);
    if (snapshot) {
      return freeze({
        knownBot: true,
        current: snapshot.current,
        historical: snapshot.historical,
        ...(snapshot.disabled ? { disabled: true } : {}),
        ready: true,
        snapshot,
      });
    }
    const rootId = resolveLiveLineageRoot(sessionId);
    if (rootId && hasBindingConflict(repo, rootId, bindingOf(repo, rootId))) {
      return freeze({ knownBot: true, current: false, historical: false, conflict: true, ready: true });
    }
    const known = binding !== undefined
      || Boolean(rootId)
      || lineage.has(sessionId)
      || membersOf(repo).some(member => member.sessionId === sessionId
        || (Array.isArray(member.previousSessionIds) && member.previousSessionIds.includes(sessionId)));
    return freeze({ knownBot: known, current: false, historical: known, ready: true });
  }

  return Object.freeze({
    version: 2,
    resolve,
    describe,
    warmLineage,
    /** Release catalog hooks; called by the plugin effect. */
    dispose() {
      for (const dispose of disposes.splice(0)) {
        try { dispose(); } catch { /* noop */ }
      }
      lineage.clear();
      pendingEdges.clear();
    },
  });
}
