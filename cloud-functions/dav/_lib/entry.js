/**
 * 云函数入口的公共装配逻辑。
 * index.js 负责 /dav，[[default]].js 负责 /dav/**，二者共用这里。
 */

import { createDavHandler } from './dav.js';
import { createBlobStore } from './store.js';

const DEFAULT_MAX_UPLOAD = 6 * 1024 * 1024; // EdgeOne 云函数请求体上限 6 MB

function truthy(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

/** 合并 process.env 与 context.env，context 优先 */
function resolveEnv(context) {
  const procEnv = (typeof process !== 'undefined' && process.env) || {};
  const ctxEnv = (context && context.env) || {};
  return { ...procEnv, ...ctxEnv };
}

export function buildConfig(env) {
  const maxUpload = Number(env.DAV_MAX_UPLOAD);
  return {
    base: env.DAV_BASE || '/dav',
    realm: env.DAV_REALM || 'EdgeOne WebDAV',
    user: env.DAV_USER || '',
    pass: env.DAV_PASS || '',
    allowAnonymous: truthy(env.DAV_ALLOW_ANONYMOUS),
    maxUpload: Number.isFinite(maxUpload) && maxUpload > 0 ? maxUpload : DEFAULT_MAX_UPLOAD,
    maxTree: Number(env.DAV_MAX_TREE) || 500,
    maxPropfindInfinity: Number(env.DAV_MAX_DEPTH_ITEMS) || 500,
    storeName: env.DAV_STORE || 'webdav',
    strong: !truthy(env.DAV_EVENTUAL) // 默认强一致
  };
}

function plain(status, message, extra = {}) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

let cachedHandler = null;
let cachedKey = '';

/** 创建 onRequest handler（跨请求复用 store 实例） */
export function createEntry() {
  return async function onRequest(context) {
    try {
      const env = resolveEnv(context);
      const config = buildConfig(env);

      // 没配账号又没显式开匿名 -> 直接拒绝，避免把存储裸奔在公网
      if (!config.user && !config.pass && !config.allowAnonymous) {
        return plain(
          503,
          'WebDAV is not configured: set the DAV_USER and DAV_PASS environment variables ' +
            '(or DAV_ALLOW_ANONYMOUS=true to allow anonymous access).'
        );
      }

      if (!context || !context.request) {
        return plain(500, 'No request in context');
      }

      const key = [
        config.storeName,
        config.base,
        config.user,
        config.strong ? 'strong' : 'eventual',
        config.maxUpload,
      ].join('|');

      if (!cachedHandler || cachedKey !== key) {
        cachedHandler = createDavHandler({
          store: createBlobStore(config.storeName, { strong: config.strong }),
          config,
        });
        cachedKey = key;
      }

      return await cachedHandler(context.request);
    } catch (err) {
      const message = (err && (err.message || String(err))) || 'unknown error';
      console.error('[webdav] unhandled', err && (err.stack || message));
      return plain(500, `Internal Server Error: ${message}`);
    }
  };
}
