import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, text, walk } from './client-harness.js';

function renderPage(loading) {
  const base = loadClient();
  const client = loadClient({ state: { ...base.initialState, loading } });
  return { client, tree: client.render(client.BotTeamPage) };
}

test('loading mask is confined to the chat view and disappears after loading', () => {
  const { tree } = renderPage(true);
  const chat = walk(tree).find(node => node.props?.className === 'bt-chat-view');
  assert.ok(chat, 'chat view is present');
  assert.equal(chat.props.style.position, 'relative', 'chat view establishes the mask containing block');
  const mask = walk(chat).find(node => node.props?.className === 'bt-root' && text(node).includes('加载 Bot Team'));
  assert.ok(mask, 'loading mask is a child of the chat view');
  assert.equal(mask.props.style.position, 'absolute');
  assert.equal(mask.props.style.inset, 0);
  assert.equal(mask.props.style.background, 'var(--bt-loading)');
  const ready = renderPage(false).tree;
  assert.equal(walk(ready).some(node => node.props?.className === 'bt-root' && text(node).includes('加载 Bot Team')), false);
});

test('dialog backdrop remains viewport fixed', () => {
  const client = loadClient();
  const modal = client.render(client.Modal, { title: 'Test', onClose() {} });
  assert.equal(modal.props.style.position, 'fixed');
  assert.equal(modal.props.style.inset, 0);
  assert.equal(modal.props.style.zIndex, 100);
  assert.ok(walk(modal).some(node => node.props?.role === 'dialog' && node.props['aria-modal'] === 'true'));
});
