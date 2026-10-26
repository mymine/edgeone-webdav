import test from 'node:test';
import assert from 'node:assert/strict';

import { createDavHandler } from '../cloud-functions/dav/_lib/dav.js';
import { normalizeDavPath } from '../cloud-functions/dav/_lib/paths.js';
import { createMemoryStore } from '../cloud-functions/dav/_lib/memory-store.js';

const AUTH = 'Basic ' + Buffer.from('alice:s3cret').toString('base64');

function makeServer(config = {}) {
  const store = createMemoryStore();
  const handler = createDavHandler({
    store,
    config: { base: '/dav', user: 'alice', pass: 's3cret', ...config },
  });
  const call = (method, path, { headers = {}, body } = {}) => {
    const init = { method, headers: { authorization: AUTH, ...headers } };
    if (body !== undefined) init.body = body;
    return handler(new Request('http://dav.local' + path, init));
  };
  return { store, handler, call };
}

async function textOf(res) {
  return await res.text();
}

test('OPTIONS 免认证，声明 DAV 1,2', async () => {
  const { call } = makeServer();
  const res = await call('OPTIONS', '/dav/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('dav'), /1/);
  assert.match(res.headers.get('allow'), /PROPFIND/);
  assert.match(res.headers.get('allow'), /MKCOL/);
});

test('未认证返回 401 且带 WWW-Authenticate', async () => {
  const { handler } = makeServer();
  const res = await handler(new Request('http://dav.local/dav/'));
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /Basic realm/);

  const bad = await handler(
    new Request('http://dav.local/dav/', {
      headers: { authorization: 'Basic ' + Buffer.from('alice:wrong').toString('base64') },
    })
  );
  assert.equal(bad.status, 401);
});

test('MKCOL 建目录 / 重复 405 / 父不存在 409', async () => {
  const { call } = makeServer();
  assert.equal((await call('MKCOL', '/dav/docs')).status, 201);
  assert.equal((await call('MKCOL', '/dav/docs')).status, 405);

  const orphan = await call('MKCOL', '/dav/a/b/c');
  assert.equal(orphan.status, 409);
});

test('PUT 新建 201、覆盖 204，GET 读回一致', async () => {
  const { call } = makeServer();
  await call('MKCOL', '/dav/docs');

  const created = await call('PUT', '/dav/docs/a.txt', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: 'hello webdav',
  });
  assert.equal(created.status, 201);
  assert.match(created.headers.get('etag') || '', /^"[0-9a-f]{32}"$/);

  const get = await call('GET', '/dav/docs/a.txt');
  assert.equal(get.status, 200);
  assert.equal(await textOf(get), 'hello webdav');
  assert.equal(get.headers.get('content-length'), '12');
  assert.match(get.headers.get('last-modified'), /GMT/);

  const overwritten = await call('PUT', '/dav/docs/a.txt', { body: 'v2' });
  assert.equal(overwritten.status, 204);
  assert.equal(await textOf(await call('GET', '/dav/docs/a.txt')), 'v2');
});

test('PUT 自动补建父目录（宽容模式）', async () => {
  const { call } = makeServer();
  const res = await call('PUT', '/dav/x/y/z.md', { body: '# hi' });
  assert.equal(res.status, 201);
  assert.equal(await textOf(await call('GET', '/dav/x/y/z.md')), '# hi');

  const listing = await textOf(await call('PROPFIND', '/dav/x', { headers: { depth: '1' } }));
  assert.match(listing, /y/);
});

test('PUT 超过上限返回 413', async () => {
  const { call } = makeServer({ maxUpload: 4 });
  const res = await call('PUT', '/dav/big.bin', { body: '1234567890' });
  assert.equal(res.status, 413);
});

test('PROPFIND Depth 0 / 1 / infinity', async () => {
  const { call } = makeServer();
  await call('MKCOL', '/dav/notes');
  await call('PUT', '/dav/notes/one.md', { body: '1' });
  await call('PUT', '/dav/notes/two.md', { body: '22' });
  await call('MKCOL', '/dav/notes/sub');
  await call('PUT', '/dav/notes/sub/three.md', { body: '333' });

  const depth0 = await textOf(await call('PROPFIND', '/dav/notes', { headers: { depth: '0' } }));
  assert.equal((depth0.match(/<D:response>/g) || []).length, 1);
  assert.match(depth0, /<D:collection\/>/);

  const depth1 = await textOf(await call('PROPFIND', '/dav/notes', { headers: { depth: '1' } }));
  assert.equal((depth1.match(/<D:response>/g) || []).length, 4); // 自身 + 2 文件 + 1 子目录
  assert.match(depth1, /one\.md/);
  assert.match(depth1, /<D:getcontentlength>2<\/D:getcontentlength>/);

  const inf = await textOf(await call('PROPFIND', '/dav/notes', { headers: { depth: 'infinity' } }));
  assert.match(inf, /three\.md/);
});

test('PROPFIND 不存在返回 404', async () => {
  const { call } = makeServer();
  assert.equal((await call('PROPFIND', '/dav/nope', { headers: { depth: '0' } })).status, 404);
});

test('中文与空格文件名的 href 编码', async () => {
  const { call } = makeServer();
  const res = await call('PUT', '/dav/文档 夹/说明 文档.txt', { body: 'x' });
  assert.equal(res.status, 201);

  const body = await textOf(await call('PROPFIND', '/dav/', { headers: { depth: '1' } }));
  assert.match(body, /%E6%96%87%E6%A1%A3%20%E5%A4%B9\//);

  const inside = await textOf(
    await call('PROPFIND', '/dav/%E6%96%87%E6%A1%A3%20%E5%A4%B9', { headers: { depth: '1' } })
  );
  assert.match(inside, /%E8%AF%B4%E6%98%8E%20%E6%96%87%E6%A1%A3\.txt/);
});

test('HEAD 不返回 body，Range 请求返回 206', async () => {
  const { call } = makeServer();
  await call('PUT', '/dav/r.txt', { body: 'abcdefghij' });

  const head = await call('HEAD', '/dav/r.txt');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await textOf(head), '');

  const part = await call('GET', '/dav/r.txt', { headers: { range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.equal(await textOf(part), 'cdef');
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');

  const suffix = await call('GET', '/dav/r.txt', { headers: { range: 'bytes=-3' } });
  assert.equal(suffix.status, 206);
  assert.equal(await textOf(suffix), 'hij');

  const bad = await call('GET', '/dav/r.txt', { headers: { range: 'bytes=99-120' } });
  assert.equal(bad.status, 416);
});

test('If-None-Match 命中返回 304', async () => {
  const { call } = makeServer();
  const put = await call('PUT', '/dav/e.txt', { body: 'v1' });
  const etag = put.headers.get('etag');
  const res = await call('GET', '/dav/e.txt', { headers: { 'if-none-match': etag } });
  assert.equal(res.status, 304);
});

test('COPY 文件与目录（递归）、Overwrite 语义', async () => {
  const { call } = makeServer();
  await call('PUT', '/dav/src/a.txt', { body: 'A' });
  await call('PUT', '/dav/src/sub/b.txt', { body: 'B' });

  const copyFile = await call('COPY', '/dav/src/a.txt', {
    headers: { destination: 'http://dav.local/dav/src/a-copy.txt' },
  });
  assert.equal(copyFile.status, 201);
  assert.equal(await textOf(await call('GET', '/dav/src/a-copy.txt')), 'A');

  const copyDir = await call('COPY', '/dav/src', {
    headers: { destination: '/dav/backup' },
  });
  assert.equal(copyDir.status, 201);
  assert.equal(await textOf(await call('GET', '/dav/backup/sub/b.txt')), 'B');

  const againNoOverwrite = await call('COPY', '/dav/src/a.txt', {
    headers: { destination: '/dav/src/a-copy.txt', overwrite: 'F' },
  });
  assert.equal(againNoOverwrite.status, 412);

  const outside = await call('COPY', '/dav/src/a.txt', {
    headers: { destination: '/other/a.txt' },
  });
  assert.equal(outside.status, 502);

  const intoItself = await call('COPY', '/dav/backup', { headers: { destination: '/dav/backup/inner' } });
  assert.equal(intoItself.status, 409);
});

test('MOVE 文件与目录', async () => {
  const { call } = makeServer();
  await call('PUT', '/dav/old/a.txt', { body: 'A' });
  await call('PUT', '/dav/old/sub/b.txt', { body: 'B' });

  const moved = await call('MOVE', '/dav/old/a.txt', { headers: { destination: '/dav/old/renamed.txt' } });
  assert.equal(moved.status, 201);
  assert.equal((await call('GET', '/dav/old/a.txt')).status, 404);
  assert.equal(await textOf(await call('GET', '/dav/old/renamed.txt')), 'A');

  const movedDir = await call('MOVE', '/dav/old/sub', { headers: { destination: '/dav/sub2' } });
  assert.equal(movedDir.status, 201);
  assert.equal(await textOf(await call('GET', '/dav/sub2/b.txt')), 'B');
  assert.equal((await call('PROPFIND', '/dav/old/sub', { headers: { depth: '0' } })).status, 404);
});

test('DELETE 文件与目录（递归）', async () => {
  const { call } = makeServer();
  await call('PUT', '/dav/tmp/a.txt', { body: 'A' });
  await call('PUT', '/dav/tmp/deep/b.txt', { body: 'B' });

  assert.equal((await call('DELETE', '/dav/tmp/a.txt')).status, 204);
  assert.equal((await call('GET', '/dav/tmp/a.txt')).status, 404);

  assert.equal((await call('DELETE', '/dav/tmp')).status, 204);
  assert.equal((await call('PROPFIND', '/dav/tmp', { headers: { depth: '0' } })).status, 404);

  assert.equal((await call('DELETE', '/dav/none')).status, 404);
  assert.equal((await call('DELETE', '/dav/')).status, 403);
});

test('LOCK 返回 token，UNLOCK 解锁，重复 LOCK 可刷新', async () => {
  const { call } = makeServer();
  await call('PUT', '/dav/lock.txt', { body: 'x' });

  const lockBody =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
    '<D:locktype><D:write/></D:locktype><D:owner>alice</D:owner></D:lockinfo>';

  const lock = await call('LOCK', '/dav/lock.txt', {
    headers: { timeout: 'Second-600', depth: '0' },
    body: lockBody,
  });
  assert.equal(lock.status, 200);
  const token = lock.headers.get('lock-token');
  assert.match(token || '', /^<opaquelocktoken:/);
  const lockXml = await textOf(lock);
  assert.match(lockXml, /activelock/);
  assert.match(lockXml, /alice/);

  const refresh = await call('LOCK', '/dav/lock.txt', { headers: { timeout: 'Second-900' } });
  assert.equal(refresh.status, 200);
  assert.match(refresh.headers.get('lock-token') || '', /opaquelocktoken/);

  const unlock = await call('UNLOCK', '/dav/lock.txt', {
    headers: { 'lock-token': token },
  });
  assert.equal(unlock.status, 204);

  // Windows 保存新文件：先 LOCK 不存在的路径 -> 应创建 0 字节占位并返回 201
  const fresh = await call('LOCK', '/dav/fresh.txt', { body: lockBody });
  assert.equal(fresh.status, 201);
  const placeholder = await call('GET', '/dav/fresh.txt');
  assert.equal(placeholder.status, 200);
  assert.equal(placeholder.headers.get('content-length'), '0');
});

test('PROPPATCH 对所有属性声明成功', async () => {
  const { call } = makeServer();
  await call('PUT', '/dav/p.txt', { body: 'x' });
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><Z:Win32LastModifiedTime xmlns:Z="urn:schemas-microsoft-com:">x</Z:Win32LastModifiedTime></D:prop></D:set></D:propertyupdate>';
  const res = await call('PROPPATCH', '/dav/p.txt', { body });
  assert.equal(res.status, 207);
  assert.match(await textOf(res), /200 OK/);
});

test('目录 GET 返回 HTML 列表页', async () => {
  const { call } = makeServer();
  await call('PUT', '/dav/list/a.txt', { body: 'x' });
  const res = await call('GET', '/dav/list');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await textOf(res);
  assert.match(html, /a\.txt/);
  assert.match(html, /WebDAV/);
});

test('未知方法返回 405', async () => {
  const { call } = makeServer();
  const res = await call('PATCH', '/dav/x');
  assert.equal(res.status, 405);
  assert.match(res.headers.get('allow') || '', /PROPFIND/);
});

test('normalizeDavPath 折叠点段、剥离挂载前缀', () => {
  assert.equal(normalizeDavPath('/dav', '/dav'), '/');
  assert.equal(normalizeDavPath('/dav/', '/dav'), '/');
  assert.equal(normalizeDavPath('/dav/a/b/', '/dav'), '/a/b');
  assert.equal(normalizeDavPath('/dav/a/./b/../c', '/dav'), '/a/c');
  // 形似但不是挂载点，不能剥离
  assert.equal(normalizeDavPath('/davx/a', '/dav'), '/davx/a');
  assert.equal(normalizeDavPath('/other/x', '/dav'), '/other/x');
  // 百分号编码解码
  assert.equal(normalizeDavPath('/dav/%E4%B8%AD%E6%96%87.txt', '/dav'), '/中文.txt');
  assert.equal(normalizeDavPath('/dav/100%25.txt', '/dav'), '/100%.txt');
});

test('存储层 key 都带统一前缀，不可能触及真实文件系统', async () => {
  const { store, call } = makeServer();
  await call('PUT', '/dav/a.txt', { body: 'x' });
  await call('MKCOL', '/dav/dir');
  const keys = [...store._map.keys()];
  assert.ok(keys.length > 0);
  for (const k of keys) {
    assert.match(k, /^[fml]/);
  }
});
