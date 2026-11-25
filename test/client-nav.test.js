// Bot Team → host shell navigation defaults: boot landing, sidebar
// choreography, project entry. Pure decision layer plus one wiring check with
// a minimal shell double (no DOM renderer, no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, text, walk } from './client-harness.js';

const client = loadClient();
const PAGE = 'bot-team';

const memory = () => {
  const map = new Map();
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    clear: () => map.clear(),
  };
};

const state = (overrides = {}) => ({ bootstrapped: false, projectId: null, ...overrides });

// ── boot landing ──────────────────────────────────────────────────────────

test('a fresh load lands on Bot Team when nothing else was explicitly chosen', () => {
  assert.equal(client.bootPanelChoice('', [PAGE, 'plugins'], PAGE), PAGE);
  assert.equal(client.bootPanelChoice(PAGE, [PAGE, 'plugins'], PAGE), PAGE);
});

test('a remembered foreign panel that is still installed keeps the user choice', () => {
  assert.equal(client.bootPanelChoice('plugins', [PAGE, 'plugins'], PAGE), null);
});

test('a remembered panel that is gone no longer vetoes the daily landing', () => {
  assert.equal(client.bootPanelChoice('uninstalled-page', [PAGE], PAGE), PAGE);
});

test('the landing waits until its own panel is registered', () => {
  assert.equal(client.bootPanelChoice('', ['plugins'], PAGE), null);
});

test('the remembered panel id is read and written through one browser key', () => {
  const store = memory();
  const reader = loadClient({ localStorage: store });
  assert.equal(reader.readHostPanelChoice(), '', 'nothing remembered yet');
  reader.persistHostPanelChoice('plugins');
  assert.equal(store.getItem(reader.HOST_PANEL_KEY), 'plugins');
  assert.equal(reader.readHostPanelChoice(), 'plugins');
  reader.persistHostPanelChoice(null);
  assert.equal(reader.readHostPanelChoice(), '', 'a null selection clears the memory');
});

test('a browser without storage keeps working and reports no memory', () => {
  const bare = loadClient();
  assert.equal(bare.readHostPanelChoice(), '');
  assert.doesNotThrow(() => bare.persistHostPanelChoice(PAGE));
});

// ── host sidebar decision ─────────────────────────────────────────────────

test('boot folds an expanded wide sidebar exactly once', () => {
  const first = client.nextHostNav(state(), { kind: 'boot', collapsed: false, narrow: false });
  assert.equal(first.action, 'collapse');
  assert.equal(first.state.bootstrapped, true);
  const second = client.nextHostNav(first.state, { kind: 'boot', collapsed: true, narrow: false });
  assert.equal(second.action, null, 'the boot default does not repeat');
});

test('boot leaves an already folded or narrow shell alone', () => {
  const folded = client.nextHostNav(state(), { kind: 'boot', collapsed: true, narrow: false });
  assert.equal(folded.action, null);
  assert.equal(folded.state.bootstrapped, true);
  const narrow = client.nextHostNav(state(), { kind: 'boot', collapsed: false, narrow: true });
  assert.equal(narrow.action, null, 'the responsive default wins');
  assert.equal(narrow.state.bootstrapped, true);
});

test('boot waits for a painted shell instead of guessing the sidebar state', () => {
  const pending = client.nextHostNav(state(), { kind: 'boot', collapsed: null, narrow: false });
  assert.equal(pending.action, null);
  assert.equal(pending.state.bootstrapped, false, 'an unknown state is not a decision');
});

test('entering a project expands a folded sidebar once per project', () => {
  const booted = state({ bootstrapped: true });
  const entered = client.nextHostNav(booted, { kind: 'selection', projectId: 'ws-1', collapsed: true, narrow: false });
  assert.equal(entered.action, 'expand');
  assert.equal(entered.state.projectId, 'ws-1');
  const again = client.nextHostNav(entered.state, { kind: 'selection', projectId: 'ws-1', collapsed: true, narrow: false });
  assert.equal(again.action, null, 'a collapse the user asked for afterwards stands');
  const next = client.nextHostNav(entered.state, { kind: 'selection', projectId: 'ws-2', collapsed: true, narrow: false });
  assert.equal(next.action, 'expand', 'another project expands again');
});

test('project entry never fights an expanded or narrow shell', () => {
  const booted = state({ bootstrapped: true });
  assert.equal(client.nextHostNav(booted, { kind: 'selection', projectId: 'ws-1', collapsed: false, narrow: false }).action, null);
  assert.equal(client.nextHostNav(booted, { kind: 'selection', projectId: 'ws-1', collapsed: true, narrow: true }).action, null);
});

test('leaving a project and re-entering the same one does not re-expand', () => {
  const booted = state({ bootstrapped: true, projectId: 'ws-1' });
  const left = client.nextHostNav(booted, { kind: 'selection', projectId: null, collapsed: true, narrow: false });
  assert.equal(left.action, null);
  assert.equal(left.state.projectId, null);
  const back = client.nextHostNav(left.state, { kind: 'selection', projectId: 'ws-1', collapsed: true, narrow: false });
  assert.equal(back.action, 'expand');
});

test('selection before the boot decision only records the project', () => {
  const pending = client.nextHostNav(state(), { kind: 'selection', projectId: 'ws-1', collapsed: true, narrow: false });
  assert.equal(pending.action, null);
  assert.equal(pending.state.projectId, 'ws-1');
  assert.equal(pending.state.bootstrapped, false);
});

test('returning to the daily page folds the tree', () => {
  const booted = state({ bootstrapped: true });
  assert.equal(client.nextHostNav(booted, { kind: 'panel', panelId: PAGE, pageKey: PAGE, collapsed: false, narrow: false }).action, 'collapse');
  assert.equal(client.nextHostNav(booted, { kind: 'panel', panelId: 'plugins', pageKey: PAGE, collapsed: false, narrow: false }).action, null);
  assert.equal(client.nextHostNav(booted, { kind: 'panel', panelId: PAGE, pageKey: PAGE, collapsed: true, narrow: false }).action, null);
});

// ── active project projection ─────────────────────────────────────────────

const sessions = (overrides = {}) => ({
  ids: ['s1'],
  byId: {
    s1: { id: 's1', retainedBy: { mainView: 1 }, cwd: '/work/advisor' },
    ...overrides.byId,
  },
  ...overrides,
});

const workspaces = (items) => ({ items });

test('the shown Session resolves to its owning project by membership first', () => {
  const snapshot = workspaces([
    { workspaceId: 'ws-a', path: '/work/a', sessionIds: [] },
    { workspaceId: 'ws-b', path: '/work/elsewhere', sessionIds: ['s1'] },
  ]);
  assert.equal(client.activeProjectId(sessions(), snapshot), 'ws-b');
});

test('a membership-less Session falls back to its working directory', () => {
  const snapshot = workspaces([{ workspaceId: 'ws-a', path: '/work/advisor', sessionIds: [] }]);
  assert.equal(client.activeProjectId(sessions(), snapshot), 'ws-a');
});

test('the daily page and Sessions outside every project resolve to null', () => {
  assert.equal(client.activeProjectId(sessions({ byId: { s1: { id: 's1', retainedBy: {} } } }), workspaces([])), null);
  assert.equal(client.activeProjectId(sessions(), workspaces([{ workspaceId: 'ws-a', path: '/other', sessionIds: [] }])), null);
  assert.equal(client.activeProjectId(null, workspaces([])), null);
  assert.equal(client.activeProjectId(sessions(), null), null);
});

// ── wiring against a minimal shell double ─────────────────────────────────

function shell({ collapsed = false, narrow = false, installed = [PAGE] } = {}) {
  const frame = { hasAttribute: name => name === 'data-sidebar-collapsed' && collapsed };
  const document = { querySelector: selector => (selector === '[data-shell-overlay]' ? { parentElement: frame } : null) };
  const calls = { select: [], toggles: 0 };
  let panelListener = null;
  let mainView = 0;
  const cwd = '/work/advisor';
  const panelInfo = {
    getSnapshot: () => ({ activePanelId: calls.select.length === 0 ? null : calls.select[calls.select.length - 1] }),
    subscribe: (listener) => { panelListener = listener; return () => { panelListener = null; }; },
  };
  const notifications = [];
  const ctx = {
    layout: {
      panelInfo,
      selectPanel: (panelId) => { calls.select.push(panelId); if (panelListener) panelListener(); },
      toggleSidebar: () => { calls.toggles += 1; collapsed = !collapsed; },
    },
    slots: { entries: () => installed.map(key => ({ options: { key } })) },
    get: name => (name === 'sessions' ? sessionSource : name === 'workspaces' ? workspaceSource : null),
  };
  const listeners = [];
  const sessionSource = {
    list: {
      getSnapshot: () => ({ ids: ['s1'], byId: { s1: { id: 's1', retainedBy: mainView === null ? {} : { mainView }, cwd } } }),
      subscribe: listener => { listeners.push(listener); return () => {}; },
    },
  };
  const workspaceSource = { list: { getSnapshot: () => workspaces([{ workspaceId: 'ws-1', path: cwd, sessionIds: ['s1'] }]), subscribe: listener => { listeners.push(listener); return () => {}; } } };
  return {
    ctx,
    calls,
    document,
    enterProject: () => { mainView = 1; listeners.forEach(listener => listener()); },
    leaveProject: () => { mainView = null; listeners.forEach(listener => listener()); },
    setPanel: (panelId) => { calls.select.push(panelId); if (panelListener) panelListener(); },
    notify: () => listeners.forEach(listener => listener()),
    get collapsed() { return collapsed; },
  };
}

function wired(options = {}) {
  const fake = shell(options);
  const store = memory();
  const client = loadClient({ document: fake.document, localStorage: store, window: { innerWidth: options.narrow ? 900 : 1440 } });
  const dispose = client.installHostNavigation(fake.ctx);
  // Assigned onto the shell double (not spread) so its live getters survive.
  return Object.assign(fake, { client, store, dispose });
}

test('the running shell opens Bot Team on a fresh load and folds its sidebar', () => {
  const run = wired();
  assert.deepEqual(run.calls.select, [PAGE], 'exactly one boot selection');
  assert.equal(run.calls.toggles, 1);
  assert.equal(run.collapsed, true);
  run.dispose();
});

test('a narrow shell keeps its responsive sidebar and still opens Bot Team', () => {
  const run = wired({ narrow: true });
  assert.deepEqual(run.calls.select, [PAGE]);
  assert.equal(run.calls.toggles, 0);
  run.dispose();
});

test('the user keeping another panel is remembered, not overwritten', () => {
  const store = memory();
  store.setItem('bot-team.host.panel', 'plugins');
  const fake = shell({ installed: [PAGE, 'plugins'] });
  const client = loadClient({ document: fake.document, localStorage: store, window: { innerWidth: 1440 } });
  const dispose = client.installHostNavigation(fake.ctx);
  assert.deepEqual(fake.calls.select, [], 'the explicit choice is not reclaimed');
  assert.equal(fake.calls.toggles, 0, 'no Bot Team flow ran, so the sidebar stays as the host left it');
  assert.equal(store.getItem('bot-team.host.panel'), 'plugins');
  dispose();
});

test('entering a project expands the folded sidebar, and a later collapse stands', () => {
  const run = wired();
  assert.equal(run.collapsed, true, 'boot folded it');
  run.enterProject('ws-1');
  assert.equal(run.collapsed, false, 'project entry expanded it');
  const togglesAfterEntry = run.calls.toggles;
  run.notify();
  assert.equal(run.calls.toggles, togglesAfterEntry, 'the same project does not re-open');
  // The user folds it again by hand, then the page re-renders.
  run.ctx.layout.toggleSidebar();
  const togglesAfterManual = run.calls.toggles;
  run.notify();
  assert.equal(run.calls.toggles, togglesAfterManual, 'a manual collapse survives notifications');
  run.dispose();
});

test('returning to the daily Bot Team page folds the tree again', () => {
  const run = wired();
  run.enterProject('ws-1');
  assert.equal(run.collapsed, false);
  run.setPanel(PAGE);
  assert.equal(run.collapsed, true);
  run.dispose();
});

test('an explicit panel pick is remembered for the next fresh load', () => {
  const run = wired();
  run.setPanel('plugins');
  assert.equal(run.store.getItem('bot-team.host.panel'), 'plugins');
  // Opening a project Session returns the shell to the Conversation.
  run.ctx.layout.selectPanel(null);
  assert.equal(run.store.getItem('bot-team.host.panel'), '', 'the Conversation clears the panel memory');
  run.dispose();
});

test('a shell without the layout service is left untouched', () => {
  const bare = loadClient();
  assert.doesNotThrow(() => bare.installHostNavigation({ slots: { entries: () => [] }, get: () => null })());
});

// ── attachment semantics ──────────────────────────────────────────────────

const attachmentMessage = (attachments) => ({
  messageId: 'm-att',
  seq: 1,
  status: 'done',
  kind: 'chat',
  text: '带附件的消息',
  author: { type: 'bot', botId: 'bot-1', name: '顾问' },
  attachments,
});

const attachmentRow = (attachments, groupId) => client.MessageRow({
  message: attachmentMessage(attachments),
  groupId,
  bots: [{ botId: 'bot-1', name: '顾问' }],
  allMessages: [],
  tasks: [],
  groupStart: true,
  groupEnd: true,
});

test('message attachments are a native list with a name and visible facts', () => {
  const row = attachmentRow([{ attachmentId: 'att-1', name: '报告.pdf', bytes: 2048, path: '/tmp/attachments/报告.pdf' }]);
  const list = walk(row).find(node => node.type === 'ul');
  assert.ok(list, 'the attachment group is a real list');
  assert.equal(list.props.role, 'list', 'flex lists lose native semantics in Safari');
  assert.equal(list.props['aria-label'], '消息附件');
  const items = walk(list).filter(node => node.type === 'li');
  assert.equal(items.length, 1);
  assert.equal(items[0].props['aria-label'], undefined, 'a plain list item is not a named widget');
  assert.equal(items[0].props.title, '/tmp/attachments/报告.pdf', 'the stored path stays available on hover');
  assert.match(text(items[0]), /报告\.pdf/);
  assert.match(text(items[0]), /2\.0 KB/);
  assert.match(text(items[0]), /只读附件/);
  const glyph = walk(items[0]).find(node => typeof node.type === 'function');
  assert.ok(glyph, 'the item carries its file glyph component');
  assert.equal(glyph.type(glyph.props).props['aria-hidden'], true, 'the decorative glyph does not double the label');
});

test('a message attachment downloads through the host attachment route', () => {
  const attachment = { attachmentId: 'att-1', name: '报告 2026.pdf', bytes: 2048, path: '/tmp/attachments/报告 2026.pdf' };
  const row = attachmentRow([attachment], 'grp-1');
  const link = walk(row).find(node => node.type === 'a' && node.props?.download);
  assert.ok(link, 'the chip is a real same-origin download link');
  assert.equal(link.props.download, attachment.name);
  assert.equal(link.props.href, client.attachmentDownloadUrl('/api/bot-team.attachment', {
    groupId: 'grp-1', attachmentId: 'att-1', name: attachment.name, bytes: 2048,
  }));
  assert.equal(link.props['aria-label'], '报告 2026.pdf · 2.0 KB · 下载附件');
  assert.equal(typeof link.props.onClick, 'function', 'the shell file-action service can take over the save');
});

test('an unaddressable attachment stays a chip instead of faking a download', () => {
  const row = attachmentRow([{ attachmentId: 'att-1', name: 'notes.txt', bytes: 12 }]);
  const list = walk(row).find(node => node.props?.role === 'list');
  assert.equal(walk(list).some(node => node.type === 'a'), false, 'no owning group means no URL');
});

test('the attachment URL needs both references and encodes every parameter', () => {
  assert.equal(
    client.attachmentDownloadUrl('/api/bot-team.attachment', { groupId: 'g 1', attachmentId: 'a&b', name: 'x y.txt', bytes: 12 }),
    '/api/bot-team.attachment?groupId=g%201&attachmentId=a%26b&name=x%20y.txt&bytes=12',
  );
  assert.equal(client.attachmentDownloadUrl('/api/bot-team.attachment', { attachmentId: 'a', name: 'x' }), '');
  assert.equal(client.attachmentDownloadUrl('/api/bot-team.attachment', { groupId: 'g', name: 'x' }), '');
  assert.equal(client.attachmentDownloadUrl('', { groupId: 'g', attachmentId: 'a' }), '');
});

test('the download falls back to the anchor when the shell exposes no file actions', () => {
  let prevented = false;
  assert.equal(client.saveAttachment({ preventDefault: () => { prevented = true; } }, '/api/x', 'n.txt'), undefined);
  assert.equal(prevented, false, 'the anchor keeps its native download');
});

test('the attachment item never implies a download the browser cannot perform', () => {
  const row = attachmentRow([{ attachmentId: 'att-1', name: 'notes.txt', bytes: 12 }]);
  const list = walk(row).find(node => node.props?.role === 'list');
  assert.equal(walk(list).some(node => node.type === 'a' || node.type === 'button'), false);
});

test('the attachment label degrades without a name and localizes the read-only fact', () => {
  assert.equal(client.attachmentLabel({ bytes: 0 }), '附件 · 0 B · 只读附件');
  client.setTestLocale('en');
  try {
    assert.equal(client.attachmentLabel({ name: 'notes.txt', bytes: 2048 }), 'notes.txt · 2.0 KB · Read-only attachment');
  } finally {
    client.setTestLocale('zh');
  }
});
