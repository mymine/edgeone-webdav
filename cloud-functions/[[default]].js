// 根级 catch-all —— 关键：EdgeOne 只在「根级」检测 [[default]].js 是否存在，
// 并据此决定是否启用 server handler 模式。放在子目录（dav/[[default]].js）时，
// 平台日志会出现 "No server-handler detected, generating routes.json for pure project"，
// catch-all 路由不会注册，/dav/** 就会落到静态路由上返回 404。
//
// 这里统一接管所有路径：命中挂载点前缀的交给 WebDAV，其余返回明确的 404 说明页
// （而不是平台那句容易误导的 "The site does not exist"）。
import { createEntry } from './dav/_lib/entry.js';
import { handlePing } from './dav/_lib/ping.js';

// 根级唯一的路由文件。cloud-functions/ 下不再有任何其它 onRequest 文件，
// 避免平台把"未匹配的路径"兜底给别的函数（实测会出现 /dav 返回 /ping 的内容）。
const entry = createEntry();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[c]);
}

function text(status, body) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function landingPage(base) {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EdgeOne WebDAV</title>
<style>body{font:14px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;max-width:640px;margin:0 auto;padding:48px 22px;color:#222}
@media (prefers-color-scheme:dark){body{background:#141414;color:#e6e6e6}a{color:#6cb6ff}h1{color:#e6e6e6}}
h1{font-size:18px;margin:0 0 10px}code,pre{background:rgba(128,128,128,.12);border-radius:6px}code{padding:1px 5px}
pre{padding:12px 14px;overflow:auto;font-size:12.5px}a{color:#0b7dd8}</style>
</head><body>
<h1>EdgeOne WebDAV</h1>
<p>云函数已生效。WebDAV 挂载点：<code>${esc(base)}</code></p>
<pre>地址: https://&lt;你的域名&gt;${esc(base)}
认证: Basic Auth（DAV_USER / DAV_PASS）</pre>
<p>自检接口：<a href="/ping">/ping</a>　｜　直接浏览目录：<a href="${esc(base)}/">${esc(base)}/</a></p>
<p style="color:#888;font-size:12.5px">若这里看到的是本页而不是自检页，说明静态首页没有部署成功，但函数是好的。</p>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default async function onRequest(context) {
  const procEnv = (typeof process !== 'undefined' && process.env) || {};
  const env = { ...procEnv, ...((context && context.env) || {}) };

  let rawBase = String(env.DAV_BASE || '/dav').trim() || '/dav';
  if (!rawBase.startsWith('/')) rawBase = '/' + rawBase;
  const base = rawBase.replace(/\/+$/, '') || '/dav';

  const request = context && context.request;
  const pathname = request ? new URL(request.url).pathname : '';

  // 挂在 WebDAV 前缀下的请求全部交给同一个 handler
  if (pathname === base || pathname.startsWith(base + '/')) {
    return entry(context);
  }

  // /ping 正常由静态路由覆盖；这里再兜一层，防止 catch-all 抢走
  if (pathname === '/ping') {
    return handlePing(context);
  }

  // 诊断端点：能返回这段 JSON 就说明根级 catch-all 生效了
  if (pathname === '/__diag') {
    const body = {
      ok: true,
      handler: 'cloud-functions/[[default]].js',
      note: 'catch-all 生效：未匹配静态资源/具名函数的请求都会到这里',
      base,
      path: pathname,
      host: request && request.headers ? request.headers.get('host') : null,
      urlPath: request ? new URL(request.url).pathname : null,
    };
    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // 根路径：静态 index.html 正常时不会走到这里；走到了也给个能用的落地页
  if (pathname === '/' || pathname === '/index.html') {
    return landingPage(base);
  }

  return text(
    404,
    [
      '404 Not Found  [cloud-functions/[[default]].js]',
      '',
      `This path is outside the WebDAV mount point (${base}).`,
      `WebDAV 挂载点是 ${base}，请用 WebDAV 客户端连接：`,
      '',
      `  ${base}`,
      '',
      '自检接口: /ping',
    ].join('\n')
  );
}
