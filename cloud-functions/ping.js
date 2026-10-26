/**
 * 自检接口（路由：/ping）
 *
 * 用途：确认云函数是否部署成功、环境变量是否注入、Blob 能否初始化。
 * 不返回任何密钥内容，只报变量名与状态。
 */

import { buildConfig } from './dav/_lib/entry.js';

export default async function onRequest(context) {
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
    version: '1.0.4',
    runtime: {
      node: typeof process !== 'undefined' ? process.version : 'unknown',
      platform: typeof process !== 'undefined' ? process.platform : 'unknown',
    },
    route: {
      method: request ? request.method : null,
      path: url ? url.pathname : null,
      base: config.base,
      // 云函数里 request.url 是内部源站地址，mount 优先按 Host 头拼公网地址
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
