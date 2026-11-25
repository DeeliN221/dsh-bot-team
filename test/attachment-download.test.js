import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BotTeamService } from '../host/service.js';

/** Minimal service surface used by the attachment download route. */
function serviceWith({ messages = [], files = {}, root }) {
  const service = {
    withReady: run => run(),
    repo: {
      getGroup: id => (id === 'group' ? { groupId: 'group' } : undefined),
      messagesOf: id => (id === 'group' ? messages : []),
    },
    attachmentStore: () => ({
      fileHostPath: ref => (files[ref.attachmentId] ? path.join(root, files[ref.attachmentId]) : undefined),
    }),
  };
  return service;
}

const call = (service, query) => BotTeamService.prototype.handleAttachmentHttp.call(
  service, new Request('http://host/api/bot-team.attachment?' + new URLSearchParams(query)),
);

test('serves an attachment already published on a group message', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-team-attachment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'report.md'), '# 交付\n');
  const messages = [{ messageId: 'm1', attachments: [{ attachmentId: 'att-1', name: 'report.md', bytes: 9 }] }];
  const response = await call(serviceWith({ messages, files: { 'att-1': 'report.md' }, root }), {
    groupId: 'group', attachmentId: 'att-1', name: 'report.md', bytes: '9',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''report\.md/);
  assert.equal(response.headers.get('content-length'), '9');
  assert.equal(await response.text(), '# 交付\n');
});

test('refuses an attachment no message of that group references', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-team-attachment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const response = await call(serviceWith({ messages: [], files: { 'att-1': 'x' }, root }), {
    groupId: 'group', attachmentId: 'att-1', name: 'x', bytes: '1',
  });
  assert.equal(response.status, 404);
});

test('refuses an unknown group and an unknown stored file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-team-attachment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unknownGroup = await call(serviceWith({ root }), {
    groupId: 'other', attachmentId: 'att-1', name: 'x', bytes: '1',
  });
  assert.equal(unknownGroup.status, 404);
  const messages = [{ messageId: 'm1', attachments: [{ attachmentId: 'att-2', name: 'gone.md', bytes: 3 }] }];
  const missing = await call(serviceWith({ messages, files: {}, root }), {
    groupId: 'group', attachmentId: 'att-2', name: 'gone.md', bytes: '3',
  });
  assert.equal(missing.status, 404);
});

test('requires the full attachment identity', async t => {
  const response = await call(serviceWith({ root: os.tmpdir() }), { groupId: 'group' });
  assert.equal(response.status, 400);
});
