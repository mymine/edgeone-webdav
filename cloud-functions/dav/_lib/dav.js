/**
 * WebDAV 服务端核心实现（零第三方依赖，Node 18+ / EdgeOne Cloud Functions）。
 *
 * 存储模型（@edgeone/pages-blob 是扁平 KV，这里在其上实现目录树）：
 *   f<path>  -> 文件二进制内容           例：/docs/a.txt => "f/docs/a.txt"
 *   m<path>  -> 元信息 JSON              例：/docs/a.txt => "m/docs/a.txt"
 *               { isDir, size, mtime, ctime, contentType, etag }
 *   目录的元信息与文件同键不同值（同名文件/目录在 WebDAV 中不可能共存），
 *   因此 list({prefix:"m/docs/", directories:true}) 一次就能拿到该目录下
 *   全部直接子项（文件 + 子目录），无需额外探测。
 *   l<path>  -> 锁信息（LOCK/UNLOCK）
 *
 * 根目录元信息固定存在键 "m" 上（"m/" 前缀不会匹配到它）。
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  normalizeDavPath,
  joinPath,
  parentOf,
  baseName,
  stripPrefix,
  toHref,
} from './paths.js';
import {
  buildMultistatus,
  buildLockResponse,
  buildProppatchResponse,
  escapeXml,
  httpDate,
  isoDate,
  parseDepth,
  parseLockOwner,
  parsePropSpecs,
  isPropnameRequest,
} from './xml.js';

const KEY_DATA = 'f';
const KEY_META = 'm';
const KEY_LOCK = 'l';

const XML_TYPE = 'application/xml; charset="utf-8"';
const DAV_ALLOW =
  'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK';

const MIME = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  ts: 'text/x-typescript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function guessContentType(p) {
  const name = baseName(p);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME[name.slice(dot + 1).toLowerCase()] || 'application/octet-stream';
}

function dataKey(p) {
  return KEY_DATA + (p === '/' ? '/' : p);
}
function metaKey(p) {
  return p === '/' ? KEY_META : KEY_META + p;
}
function lockKey(p) {
  return p === '/' ? KEY_LOCK : KEY_LOCK + p;
}
function metaPrefix(p) {
  return p === '/' ? KEY_META + '/' : KEY_META + p + '/';
}
function dataPrefix(p) {
  return p === '/' ? KEY_DATA + '/' : KEY_DATA + p + '/';
}

/** 有并发上限的 map */
async function mapLimit(items, limit, fn) {
  const arr = Array.isArray(items) ? items : [...items];
  const results = new Array(arr.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit || 1, arr.length));
  const workers = new Array(size).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= arr.length) return;
      results[i] = await fn(arr[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Node stream / web stream 统一成 Response 可接受的 body */
function toBodyStream(body) {
  if (!body) return null;
  if (typeof body.getReader === 'function') return body;
  if (typeof body.pipe === 'function') return Readable.toWeb(body);
  return null;
}

function emptyResponse(status, headers = {}) {
  return new Response(null, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

function textResponse(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function xmlResponse(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': XML_TYPE,
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function parseRangeHeader(value, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(value || '').trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return 'invalid';
  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? total - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= total) return 'invalid';
  return { start, end: Math.min(end, total - 1) };
}

function parseTimeoutHeader(value) {
  const raw = String(value || '').trim();
  const m = /Second-(\d+)/i.exec(raw);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 86400);
  }
  if (/Infinite/i.test(raw)) return 86400;
  return 3600;
}

function timingSafeStringEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * @param {{store: object, config?: object}} deps
 * store 需实现 set/get/delete/list，见 _lib/store.js
 */
export function createDavHandler({ store, config = {} }) {
  const cfg = {
    base: '/dav',
    realm: 'EdgeOne WebDAV',
    user: '',
    pass: '',
    allowAnonymous: false,
    maxUpload: 6 * 1024 * 1024,
    maxTree: 500,
    maxPropfindInfinity: 500,
    concurrency: 8,
    ...config,
  };

  // 规范化 base（去掉尾部斜杠）
  const base = (() => {
    let b = String(cfg.base || '').trim();
    if (!b || b === '/') return '';
    if (!b.startsWith('/')) b = '/' + b;
    return b.replace(/\/+$/, '');
  })();
  cfg.base = base;

  // ---------- 元信息 ----------

  function normalizeMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const isDir = raw.isDir === true;
    return {
      isDir,
      size: isDir ? 0 : Number(raw.size) || 0,
      mtime: Number(raw.mtime) || Date.now(),
      ctime: Number(raw.ctime) || Number(raw.mtime) || Date.now(),
      contentType: isDir ? 'httpd/unix-directory' : raw.contentType || 'application/octet-stream',
      etag: raw.etag || '',
    };
  }

  async function readMeta(p) {
    let raw;
    try {
      raw = await store.get(metaKey(p), { type: 'json' });
    } catch {
      raw = null;
    }
    return normalizeMeta(raw);
  }

  async function writeMeta(p, meta) {
    const payload = {
      isDir: !!meta.isDir,
      size: Number(meta.size) || 0,
      mtime: Number(meta.mtime) || Date.now(),
      ctime: Number(meta.ctime) || Number(meta.mtime) || Date.now(),
      contentType: meta.contentType || 'application/octet-stream',
      etag: meta.etag || '',
    };
    await store.set(metaKey(p), JSON.stringify(payload));
    return payload;
  }

  async function ensureRoot() {
    const m = await readMeta('/');
    if (m) return m;
    const now = Date.now();
    return writeMeta('/', { isDir: true, size: 0, mtime: now, ctime: now });
  }

  /** 路径状态：null 表示不存在 */
  async function statPath(p) {
    if (p === '/') return ensureRoot();

    const m = await readMeta(p);
    if (m) return m;

    // 兜底：没有元信息但下面挂了内容，视为集合（历史数据 / 异常中断）
    try {
      const res = await store.list({ prefix: metaPrefix(p), directories: false });
      if ((res.blobs || []).length > 0) {
        const now = Date.now();
        return { isDir: true, size: 0, mtime: now, ctime: now, contentType: 'httpd/unix-directory', etag: '' };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /** 列出目录下的直接子项（含子目录），返回 [{ name, path, meta }] */
  async function listChildren(p) {
    const prefix = metaPrefix(p);
    const res = await store.list({ prefix, directories: true });
    const names = new Map(); // name -> 'meta' | 'dir'

    for (const blob of res.blobs || []) {
      const rel = stripPrefix(blob && blob.key, prefix);
      if (!rel) continue;
      const slash = rel.indexOf('/');
      if (slash >= 0) {
        // 有更深层级但没有自身元信息 -> 仍按目录处理
        const first = rel.slice(0, slash);
        if (first && !names.has(first)) names.set(first, 'dir');
        continue;
      }
      names.set(rel, 'meta');
    }

    for (const dir of res.directories || []) {
      let rel = String(dir);
      if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
      rel = rel.replace(/\/+$/, '');
      if (!rel) continue;
      const slash = rel.indexOf('/');
      const name = slash >= 0 ? rel.slice(0, slash) : rel;
      if (name && !names.has(name)) names.set(name, 'dir');
    }

    const pairs = [...names.entries()];
    const metas = await mapLimit(pairs, cfg.concurrency, async ([name, kind]) => {
      if (kind === 'dir') return null;
      return readMeta(joinPath(p, name));
    });

    const children = [];
    pairs.forEach(([name, kind], i) => {
      const childPath = joinPath(p, name);
      const meta = metas[i];
      if (meta) {
        children.push({ name, path: childPath, meta });
      } else if (kind === 'dir') {
        const now = Date.now();
        children.push({
          name,
          path: childPath,
          meta: { isDir: true, size: 0, mtime: now, ctime: now, contentType: 'httpd/unix-directory', etag: '' },
        });
      }
    });

    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return children;
  }

  function toEntry(p, meta, displayName) {
    return {
      href: toHref(base, p, meta.isDir),
      displayName: displayName ?? baseName(p),
      isDir: !!meta.isDir,
      size: meta.size || 0,
      mtime: meta.mtime || Date.now(),
      ctime: meta.ctime || meta.mtime || Date.now(),
      contentType: meta.contentType,
      etag: meta.etag || '',
    };
  }

  // ---------- 锁 ----------

  async function readLock(p) {
    try {
      const raw = await store.get(lockKey(p), { type: 'json' });
      if (!raw || typeof raw !== 'object') return null;
      if (Number(raw.expires) && Number(raw.expires) < Date.now()) return null;
      return {
        token: String(raw.token || ''),
        owner: String(raw.owner || ''),
        depth: raw.depth === '0' ? '0' : 'infinity',
        timeout: Number(raw.timeout) || 3600,
        expires: Number(raw.expires) || 0,
      };
    } catch {
      return null;
    }
  }

  async function writeLock(p, lock) {
    await store.set(lockKey(p), JSON.stringify(lock));
    return lock;
  }

  // ---------- 删除 ----------

  async function deleteTree(p) {
    const [metaRes, dataRes] = await Promise.all([
      store.list({ prefix: metaPrefix(p), directories: false }),
      store.list({ prefix: dataPrefix(p), directories: false }),
    ]);
    const keys = [];
    for (const b of metaRes.blobs || []) if (b && b.key) keys.push(b.key);
    for (const b of dataRes.blobs || []) if (b && b.key) keys.push(b.key);
    await mapLimit(keys, 16, (k) => store.delete(k).catch(() => {}));
    await Promise.all([
      store.delete(metaKey(p)).catch(() => {}),
      store.delete(lockKey(p)).catch(() => {}),
    ]);
    return keys.length;
  }

  // ---------- 复制 ----------

  async function copyFile(src, dst, srcMeta) {
    const buf = await store.get(dataKey(src), { type: 'arrayBuffer' });
    if (buf == null) return false;
    await store.set(dataKey(dst), buf);
    await writeMeta(dst, {
      isDir: false,
      size: srcMeta.size || (buf.byteLength ?? 0),
      mtime: Date.now(),
      ctime: Date.now(),
      contentType: srcMeta.contentType,
      etag: srcMeta.etag,
    });
    return true;
  }

  async function copyTree(src, dst, srcMeta, depth) {
    const now = Date.now();
    if (!srcMeta.isDir) {
      return copyFile(src, dst, srcMeta);
    }

    await writeMeta(dst, {
      isDir: true,
      size: 0,
      mtime: now,
      ctime: now,
      contentType: 'httpd/unix-directory',
      etag: '',
    });
    if (depth === '0') return true;

    const res = await store.list({ prefix: metaPrefix(src), directories: false });
    const rels = [];
    for (const b of res.blobs || []) {
      const rel = stripPrefix(b && b.key, metaPrefix(src));
      if (rel) rels.push(rel);
    }
    if (rels.length > cfg.maxTree) {
      throw new Error(`Too many entries under ${src} (${rels.length} > ${cfg.maxTree})`);
    }

    await mapLimit(rels, 4, async (rel) => {
      const sp = joinPath(src, rel);
      const dp = joinPath(dst, rel);
      const m = await readMeta(sp);
      if (!m) return;
      if (m.isDir) {
        await writeMeta(dp, { ...m, mtime: now, ctime: now });
        return;
      }
      await copyFile(sp, dp, m);
    });
    return true;
  }

  // ---------- 认证 ----------

  function isAuthorized(request) {
    if (!cfg.user && !cfg.pass) return cfg.allowAnonymous === true;
    const header = request.headers.get('authorization') || '';
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
    if (!m) return false;
    let decoded;
    try {
      decoded = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
      return false;
    }
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    return timingSafeStringEqual(user, cfg.user) && timingSafeStringEqual(pass, cfg.pass);
  }

  function unauthorized() {
    return textResponse(401, 'Unauthorized', {
      'WWW-Authenticate': `Basic realm="${cfg.realm}", charset="UTF-8"`,
    });
  }

  // ---------- 请求体 ----------

  async function readBodyText(request) {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > 512 * 1024) return '';
    try {
      return await request.text();
    } catch {
      return '';
    }
  }

  // ---------- 各 HTTP 方法 ----------

  function handleOptions(request, p) {
    return emptyResponse(200, {
      Allow: DAV_ALLOW,
      DAV: '1, 2',
      'MS-Author-Via': 'DAV',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': DAV_ALLOW,
      'Access-Control-Allow-Headers':
        'Authorization, Depth, Destination, Overwrite, If, Lock-Token, Timeout, Content-Type, Range',
      'Access-Control-Max-Age': '86400',
    });
  }

  async function handlePropfind(request, p) {
    const st = await statPath(p);
    if (!st) return textResponse(404, 'Not Found');

    const depth = parseDepth(request.headers.get('depth'), 'infinity');
    const body = await readBodyText(request);
    const propname = isPropnameRequest(body);

    const entries = [toEntry(p, st, baseName(p))];

    if (depth !== '0' && st.isDir) {
      if (depth === '1') {
        const children = await listChildren(p);
        for (const child of children) {
          entries.push(toEntry(child.path, child.meta, child.name));
        }
      } else {
        const res = await store.list({ prefix: metaPrefix(p), directories: false });
        const rels = [];
        for (const b of res.blobs || []) {
          const rel = stripPrefix(b && b.key, metaPrefix(p));
          if (rel) rels.push(rel);
          if (rels.length >= cfg.maxPropfindInfinity) break;
        }
        const metas = await mapLimit(rels, cfg.concurrency, (rel) => readMeta(joinPath(p, rel)));
        rels.forEach((rel, i) => {
          if (metas[i]) entries.push(toEntry(joinPath(p, rel), metas[i], baseName(rel)));
        });
      }
    }

    return xmlResponse(207, buildMultistatus(entries, { propname }));
  }

  async function handleProppatch(request, p) {
    const st = await statPath(p);
    if (!st) return textResponse(404, 'Not Found');
    const body = await readBodyText(request);
    const specs = parsePropSpecs(body);
    return xmlResponse(207, buildProppatchResponse(toHref(base, p, st.isDir), specs));
  }

  function handleLock(request, p) {
    return (async () => {
      const body = await readBodyText(request);
      const isRefresh = !body || !body.trim();

      let st = await statPath(p);
      let created = false;
      if (!st) {
        // Windows 资源管理器保存新文件时会先 LOCK 一个还不存在的路径。
        // RFC 4918 允许此时创建空资源并返回 201，照做以兼容各家客户端。
        const parentsOk = await ensureParents(p);
        if (!parentsOk) return textResponse(409, 'A parent path is occupied by a file');
        const now = Date.now();
        await store.set(dataKey(p), new ArrayBuffer(0));
        await writeMeta(p, {
          isDir: false,
          size: 0,
          mtime: now,
          ctime: now,
          contentType: guessContentType(p),
          etag: `"${createHash('md5').update(Buffer.alloc(0)).digest('hex')}"`,
        });
        st = await statPath(p);
        created = true;
      }

      const timeout = parseTimeoutHeader(request.headers.get('timeout'));
      const depthHeader = parseDepth(request.headers.get('depth'), 'infinity');
      const depth = depthHeader === '0' ? '0' : 'infinity';
      const href = toHref(base, p, st.isDir);

      let lock = isRefresh ? await readLock(p) : null;
      if (!lock) {
        lock = {
          token: `opaquelocktoken:${randomUUID()}`,
          owner: isRefresh ? '' : parseLockOwner(body),
          depth,
          timeout,
          expires: 0,
        };
      }
      lock.timeout = timeout;
      lock.expires = Date.now() + timeout * 1000;
      await writeLock(p, lock);

      return xmlResponse(created ? 201 : 200, buildLockResponse(lock, href), {
        'Lock-Token': `<${lock.token}>`,
        Timeout: `Second-${timeout}`,
      });
    })();
  }

  async function handleUnlock(request, p) {
    const st = await statPath(p);
    if (!st) return textResponse(404, 'Not Found');
    // 宽容模式：不校验 Lock-Token（本服务不做真正的写互斥），
    // 避免客户端与服务端锁状态不一致时把文件卡死。
    await store.delete(lockKey(p)).catch(() => {});
    return emptyResponse(204);
  }

  async function handleGet(request, p, headOnly) {
    const st = await statPath(p);
    if (!st) return textResponse(404, 'Not Found');

    if (st.isDir) {
      if (headOnly) {
        return emptyResponse(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Last-Modified': httpDate(st.mtime),
        });
      }
      const children = await listChildren(p);
      return new Response(renderDirectoryListing(p, children), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    const headers = {
      'Content-Type': st.contentType || 'application/octet-stream',
      'Last-Modified': httpDate(st.mtime),
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    };
    if (st.etag) headers.ETag = st.etag;

    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch && st.etag) {
      const candidates = ifNoneMatch.split(',').map((s) => s.trim());
      if (candidates.includes(st.etag) || candidates.includes('*')) {
        return emptyResponse(304, headers);
      }
    }

    const rangeHeader = request.headers.get('range');
    if (rangeHeader && st.size > 0 && st.size <= 8 * 1024 * 1024) {
      const buf = await store.get(dataKey(p), { type: 'arrayBuffer' });
      if (!buf) return textResponse(404, 'Not Found');
      const total = buf.byteLength;
      const parsed = parseRangeHeader(rangeHeader, total);
      if (parsed === 'invalid') {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { ...headers, 'Content-Range': `bytes */${total}` },
        });
      }
      if (parsed) {
        const slice = buf.slice(parsed.start, parsed.end + 1);
        return new Response(headOnly ? null : slice, {
          status: 206,
          headers: {
            ...headers,
            'Content-Range': `bytes ${parsed.start}-${parsed.end}/${total}`,
            'Content-Length': String(slice.byteLength),
          },
        });
      }
    }

    if (headOnly) {
      return emptyResponse(200, { ...headers, 'Content-Length': String(st.size || 0) });
    }

    const raw = await store.get(dataKey(p), { type: 'stream' });
    const stream = toBodyStream(raw);
    if (!stream) return textResponse(404, 'Not Found');
    return new Response(stream, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(st.size || 0) },
    });
  }

  async function ensureParents(p) {
    const parent = parentOf(p);
    if (parent === '/') {
      await ensureRoot();
      return true;
    }
    const segs = parent.split('/').filter(Boolean);
    let cur = '';
    for (const seg of segs) {
      cur += '/' + seg;
      const m = await readMeta(cur);
      if (!m) {
        const now = Date.now();
        await writeMeta(cur, {
          isDir: true,
          size: 0,
          mtime: now,
          ctime: now,
          contentType: 'httpd/unix-directory',
          etag: '',
        });
      } else if (!m.isDir) {
        return false;
      }
    }
    return true;
  }

  async function handlePut(request, p) {
    if (p === '/') return textResponse(405, 'Cannot PUT the root collection');

    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > cfg.maxUpload) {
      return textResponse(
        413,
        `Payload Too Large: ${declared} bytes exceeds limit ${cfg.maxUpload} bytes`
      );
    }
    if (request.headers.get('content-range')) {
      return textResponse(400, 'Partial PUT (Content-Range) is not supported');
    }

    const existing = await statPath(p);
    if (existing && existing.isDir) {
      return textResponse(409, 'A collection exists at this path');
    }

    let buf;
    try {
      buf = await request.arrayBuffer();
    } catch (err) {
      return textResponse(400, `Unable to read request body: ${err && err.message}`);
    }
    if (buf.byteLength > cfg.maxUpload) {
      return textResponse(
        413,
        `Payload Too Large: ${buf.byteLength} bytes exceeds limit ${cfg.maxUpload} bytes`
      );
    }

    const parentsOk = await ensureParents(p);
    if (!parentsOk) return textResponse(409, 'A parent path is occupied by a file');

    const now = Date.now();
    const etag = `"${createHash('md5').update(Buffer.from(buf)).digest('hex')}"`;
    const contentType =
      request.headers.get('content-type') || guessContentType(p);

    await store.set(dataKey(p), buf);
    await writeMeta(p, {
      isDir: false,
      size: buf.byteLength,
      mtime: now,
      ctime: existing ? existing.ctime : now,
      contentType,
      etag,
    });

    return emptyResponse(existing ? 204 : 201, { ETag: etag });
  }

  async function handleMkcol(request, p) {
    if (p === '/') return textResponse(405, 'Root collection already exists');
    const body = await readBodyText(request);
    if (body && body.trim()) return textResponse(415, 'MKCOL body is not supported');

    const existing = await statPath(p);
    if (existing) return textResponse(405, 'Resource already exists');

    const parent = await statPath(parentOf(p));
    if (!parent) return textResponse(409, 'Parent collection does not exist');
    if (!parent.isDir) return textResponse(409, 'Parent is not a collection');

    const now = Date.now();
    await writeMeta(p, {
      isDir: true,
      size: 0,
      mtime: now,
      ctime: now,
      contentType: 'httpd/unix-directory',
      etag: '',
    });
    return emptyResponse(201);
  }

  async function handleDelete(p) {
    if (p === '/') return textResponse(403, 'Refusing to delete the root collection');
    const st = await statPath(p);
    if (!st) return textResponse(404, 'Not Found');

    if (st.isDir) {
      await deleteTree(p);
    } else {
      await Promise.all([
        store.delete(dataKey(p)).catch(() => {}),
        store.delete(metaKey(p)).catch(() => {}),
        store.delete(lockKey(p)).catch(() => {}),
      ]);
    }
    return emptyResponse(204);
  }

  function parseDestination(header, requestUrl) {
    const raw = String(header || '').trim();
    if (!raw) return null;
    let pathname;
    if (/^https?:\/\//i.test(raw)) {
      try {
        pathname = new URL(raw).pathname;
      } catch {
        return null;
      }
    } else if (raw.startsWith('/')) {
      pathname = raw.split('?')[0];
    } else {
      try {
        pathname = new URL(raw, requestUrl).pathname;
      } catch {
        return null;
      }
    }
    if (base) {
      if (!(pathname === base || pathname.startsWith(base + '/'))) return null;
    }
    return normalizeDavPath(pathname, base);
  }

  async function handleCopyMove(request, srcPath, isMove) {
    const destPath = parseDestination(request.headers.get('destination'), request.url);
    if (destPath == null) return textResponse(502, 'Missing or invalid Destination header');
    if (destPath === srcPath) return textResponse(403, 'Source and destination are the same');

    const srcStat = await statPath(srcPath);
    if (!srcStat) return textResponse(404, 'Source not found');

    const overwrite = String(request.headers.get('overwrite') || 'T').toUpperCase() !== 'F';
    const destStat = await statPath(destPath);
    if (destStat && !overwrite) return textResponse(412, 'Destination exists (Overwrite: F)');

    if (srcStat.isDir) {
      const srcPrefix = srcPath === '/' ? '/' : srcPath + '/';
      if (destPath === '/' || (destPath + '/').startsWith(srcPrefix)) {
        return textResponse(409, 'Cannot copy or move a collection into itself');
      }
    }

    const destParent = await statPath(parentOf(destPath));
    if (!destParent) return textResponse(409, 'Destination parent does not exist');
    if (!destParent.isDir) return textResponse(409, 'Destination parent is not a collection');

    const status = destStat ? 204 : 201;
    if (destStat) {
      if (destStat.isDir) await deleteTree(destPath);
      else {
        await Promise.all([
          store.delete(dataKey(destPath)).catch(() => {}),
          store.delete(metaKey(destPath)).catch(() => {}),
        ]);
      }
    }

    const depth = parseDepth(request.headers.get('depth'), 'infinity');
    await copyTree(srcPath, destPath, srcStat, depth);

    if (isMove) {
      if (srcStat.isDir) await deleteTree(srcPath);
      else {
        await Promise.all([
          store.delete(dataKey(srcPath)).catch(() => {}),
          store.delete(metaKey(srcPath)).catch(() => {}),
          store.delete(lockKey(srcPath)).catch(() => {}),
        ]);
      }
    }

    return emptyResponse(status);
  }

  function renderDirectoryListing(p, children) {
    const mount = base || '';
    const parts = p.split('/').filter(Boolean);
    let crumb = `<a href="${escapeXml(mount + '/')}">${escapeXml(mount || '/')}</a>`;
    let acc = '';
    parts.forEach((seg, i) => {
      acc += '/' + seg;
      const href = mount + acc.split('/').map(encodeURIComponent).join('/') + '/';
      crumb += ` / <a href="${escapeXml(href)}">${escapeXml(seg)}</a>`;
      if (i === parts.length - 1) return;
    });

    const rows = children
      .map((c) => {
        const href = mount + c.path.split('/').map(encodeURIComponent).join('/') + (c.meta.isDir ? '/' : '');
        const size = c.meta.isDir ? '-' : formatSize(c.meta.size);
        const time = new Date(c.meta.mtime || Date.now()).toISOString().replace('T', ' ').slice(0, 19);
        const label = c.name + (c.meta.isDir ? '/' : '');
        return `<tr><td><a href="${escapeXml(href)}">${escapeXml(label)}</a></td><td class="n">${size}</td><td class="n">${time}</td></tr>`;
      })
      .join('');

    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(p)} - WebDAV</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:24px;background:#fafafa;color:#222}
  @media (prefers-color-scheme:dark){body{background:#141414;color:#e6e6e6}a{color:#6cb6ff}}
  h1{font-size:16px;font-weight:600;margin:0 0 4px}
  .crumb{font-size:12px;color:#888;margin-bottom:16px;word-break:break-all}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid rgba(128,128,128,.18)}
  th{font-size:12px;color:#888;font-weight:500}
  td.n{white-space:nowrap;font-variant-numeric:tabular-nums;color:#777;font-size:12px}
  a{text-decoration:none}a:hover{text-decoration:underline}
  .tip{margin-top:18px;font-size:12px;color:#999}
</style></head>
<body>
<h1>WebDAV 目录</h1>
<div class="crumb">${crumb}</div>
<table><thead><tr><th>名称</th><th>大小</th><th>修改时间 (UTC)</th></tr></thead><tbody>${rows || '<tr><td colspan="3" style="color:#999">空目录</td></tr>'}</tbody></table>
<div class="tip">这是 WebDAV 挂载点，请用 WebDAV 客户端连接（如 Finder / Windows 资源管理器 / rclone / Cyberduck）。</div>
</body></html>`;
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  // ---------- 总入口 ----------

  return async function handleDav(request) {
    const url = new URL(request.url);
    const method = String(request.method || 'GET').toUpperCase();

    // OPTIONS 放行（Windows 资源管理器与 CORS 预检都会先打它）
    if (method === 'OPTIONS') {
      return handleOptions(request, normalizeDavPath(url.pathname, base));
    }

    if (!isAuthorized(request)) return unauthorized();

    const p = normalizeDavPath(url.pathname, base);
    // Blob key 上限 600 字节（页面存储层限制），这里给 "m"+path 留足余量
    if (Buffer.byteLength(p, 'utf8') > 480) {
      return textResponse(414, 'URI Too Long: path exceeds the storage key limit');
    }

    try {
      switch (method) {
        case 'PROPFIND':
          return await handlePropfind(request, p);
        case 'PROPPATCH':
          return await handleProppatch(request, p);
        case 'GET':
          return await handleGet(request, p, false);
        case 'HEAD':
          return await handleGet(request, p, true);
        case 'PUT':
          return await handlePut(request, p);
        case 'DELETE':
          return await handleDelete(p);
        case 'MKCOL':
          return await handleMkcol(request, p);
        case 'COPY':
          return await handleCopyMove(request, p, false);
        case 'MOVE':
          return await handleCopyMove(request, p, true);
        case 'LOCK':
          return await handleLock(request, p);
        case 'UNLOCK':
          return await handleUnlock(request, p);
        default:
          return textResponse(405, `Method Not Allowed: ${method}`, { Allow: DAV_ALLOW });
      }
    } catch (err) {
      console.error('[webdav] handler error', method, p, err && (err.stack || err.message || err));
      return textResponse(500, `Internal Server Error: ${(err && err.message) || err}`);
    }
  };
}
