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

  const result = {
    ok: true,
    service: 'edgeone-webdav',
    version: '1.0.2',
    runtime: {
      node: typeof process !== 'undefined' ? process.version : 'unknown',
      platform: typeof process !== 'undefined' ? process.platform : 'unknown',
    },
    route: {
      method: request ? request.method : null,
      path: url ? url.pathname : null,
      base: config.base,
      mount: url ? url.origin + config.base : config.base,
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
