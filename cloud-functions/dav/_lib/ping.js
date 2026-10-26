/**
 * /ping 自检逻辑。
 * 注意：这里用命名导出（不是 default onRequest），放在 _lib 下，
 * 平台不会把它注册成独立路由 —— 路由入口只有根级一个 [[default]].js。
 */

import { buildConfig } from './entry.js';

export async function handlePing(context) {
  const procEnv = (typeof process !== 'undefined' && process.env) || {};
  const env = { ...procEnv, ...((context && context.env) || {}) };
  const config = buildConfig(env);

  const request = context && context.request;
  const url = request ? new URL(request.url) : null;
  const headers = (request && request.headers) || null;
  const host = headers ? headers.get('host') : null;
  const proto = (headers && headers.get('x-forwarded-proto')) || 'https';
  const publicOrigin = host ? `${proto}://${host}` : url ? url.origin : '';

  const result = {
    ok: true,
    service: 'edgeone-webdav',
    handler: 'cloud-functions/[[default]].js → /ping',
    version: '1.0.7',
    runtime: {
      node: typeof process !== 'undefined' ? process.version : 'unknown',
      platform: typeof process !== 'undefined' ? process.platform : 'unknown',
    },
    route: {
      method: request ? request.method : null,
      path: url ? url.pathname : null,
      base: config.base,
      mount: publicOrigin ? publicOrigin + config.base : config.base,
      originFromUrl: url ? url.origin : null,
    },
    config: {
      storeName: config.storeName,
      consistency: config.strong ? 'strong' : 'eventual',
      maxUpload: config.maxUpload,
      authConfigured: !!(config.user || config.pass),
      allowAnonymous: config.allowAnonymous,
      davEnvKeys: Object.keys(env).filter((k) => k.startsWith('DAV_')).sort(),
    },
    time: new Date().toISOString(),
  };

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
