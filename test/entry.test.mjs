import test from 'node:test';
import assert from 'node:assert/strict';

import { createEntry, buildConfig } from '../cloud-functions/dav/_lib/entry.js';

test('buildConfig 默认值', () => {
  const cfg = buildConfig({});
  assert.equal(cfg.base, '/dav');
  assert.equal(cfg.storeName, 'webdav');
  assert.equal(cfg.maxUpload, 6 * 1024 * 1024);
  assert.equal(cfg.strong, true);
  assert.equal(cfg.allowAnonymous, false);
});

test('buildConfig 读取环境变量', () => {
  const cfg = buildConfig({
    DAV_BASE: '/files/',
    DAV_STORE: 'my-dav',
    DAV_USER: 'u',
    DAV_PASS: 'p',
    DAV_MAX_UPLOAD: '1024',
    DAV_EVENTUAL: 'true',
    DAV_ALLOW_ANONYMOUS: 'TRUE',
  });
  assert.equal(cfg.base, '/files/');
  assert.equal(cfg.storeName, 'my-dav');
  assert.equal(cfg.maxUpload, 1024);
  assert.equal(cfg.strong, false);
  assert.equal(cfg.allowAnonymous, true);
});

test('未配置账号时拒绝服务并提示配置（503）', async () => {
  const entry = createEntry();
  const res = await entry({
    request: new Request('https://example.com/dav/'),
    env: {},
  });
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.match(body, /DAV_USER/);
  assert.match(body, /DAV_PASS/);
});

test('缺少 request 时返回 500 而不是崩溃', async () => {
  const entry = createEntry();
  const res = await entry({ env: { DAV_USER: 'u', DAV_PASS: 'p' } });
  assert.equal(res.status, 500);
});
