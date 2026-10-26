#!/usr/bin/env node
/**
 * 本地调试服务器：把 WebDAV handler 挂到 node:http 上，数据放内存。
 * 不联网、不需要 EdgeOne 账号，用来验证方法与协议细节。
 *
 *   node scripts/dev-server.mjs
 *   curl -u dav:dav -X PROPFIND -H 'Depth: 1' http://127.0.0.1:8787/dav/
 *
 * 默认账号 dav / dav，可用 DAV_USER / DAV_PASS 覆盖；端口用 PORT 覆盖。
 */

import http from 'node:http';

import { createDavHandler } from '../cloud-functions/dav/_lib/dav.js';
import { createMemoryStore } from '../cloud-functions/dav/_lib/memory-store.js';

const port = Number(process.env.PORT) || 8787;
const user = process.env.DAV_USER || 'dav';
const pass = process.env.DAV_PASS || 'dav';

const store = createMemoryStore();
const handler = createDavHandler({
  store,
  config: { base: '/dav', user, pass },
});

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const request = new Request(`http://${req.headers.host || `127.0.0.1:${port}`}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body,
    });

    const response = await handler(request);
    const headers = {};
    for (const [key, value] of response.headers.entries()) headers[key] = value;
    res.writeHead(response.status, headers);

    if (!response.body) {
      res.end();
      return;
    }
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error('[dev-server]', err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
});

server.listen(port, () => {
  console.log(`WebDAV dev server: http://127.0.0.1:${port}/dav/  (user=${user})`);
});
