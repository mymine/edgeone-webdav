/**
 * WebDAV 用到的 XML 生成 / 解析工具（零依赖）。
 */

const DAV_NS = 'DAV:';

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

/** HTTP 日期格式（Fri, 26 Oct 2026 04:06:22 GMT） */
export function httpDate(ms) {
  const d = new Date(Number(ms) || Date.now());
  return d.toUTCString();
}

/** ISO8601 格式（2026-10-26T04:06:22Z），creationdate 用 */
export function isoDate(ms) {
  const d = new Date(Number(ms) || Date.now());
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function supportedLockXml() {
  return (
    '<D:supportedlock>' +
    '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
    '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
    '</D:supportedlock>'
  );
}

function activeLockXml(lock, href) {
  if (!lock) return '<D:lockdiscovery/>';
  const token = lock.token || '';
  const owner = lock.owner ? `<D:owner>${escapeXml(lock.owner)}</D:owner>` : '<D:owner/>';
  const timeout = Number(lock.timeout) > 0 ? Number(lock.timeout) : 3600;
  const depth = lock.depth === '0' ? '0' : 'infinity';
  return (
    '<D:lockdiscovery><D:activelock>' +
    '<D:locktype><D:write/></D:locktype>' +
    '<D:lockscope><D:exclusive/></D:lockscope>' +
    `<D:depth>${depth}</D:depth>` +
    owner +
    `<D:timeout>Second-${timeout}</D:timeout>` +
    `<D:locktoken><D:href>${escapeXml(token)}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${escapeXml(href)}</D:href></D:lockroot>` +
    '</D:activelock></D:lockdiscovery>'
  );
}

/**
 * 生成 PROPFIND 的 207 响应体。
 * entries: [{ href, isDir, size, mtime, ctime, contentType, etag, displayName }]
 */
export function buildMultistatus(entries, { propname = false } = {}) {
  const parts = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<D:multistatus xmlns:D="${DAV_NS}">`,
  ];

  for (const e of entries) {
    const href = escapeXml(e.href);
    const props = [];

    if (propname) {
      props.push(
        '<D:displayname/>',
        '<D:resourcetype/>',
        '<D:getcontentlength/>',
        '<D:getcontenttype/>',
        '<D:getlastmodified/>',
        '<D:creationdate/>',
        '<D:getetag/>'
      );
    } else {
      props.push(`<D:displayname>${escapeXml(e.displayName ?? '')}</D:displayname>`);
      if (e.isDir) {
        props.push('<D:resourcetype><D:collection/></D:resourcetype>');
        props.push('<D:getcontentlength>0</D:getcontentlength>');
        props.push('<D:getcontenttype>httpd/unix-directory</D:getcontenttype>');
      } else {
        props.push('<D:resourcetype/>');
        props.push(`<D:getcontentlength>${Number(e.size) || 0}</D:getcontentlength>`);
        props.push(
          `<D:getcontenttype>${escapeXml(e.contentType || 'application/octet-stream')}</D:getcontenttype>`
        );
      }
      props.push(`<D:getlastmodified>${httpDate(e.mtime)}</D:getlastmodified>`);
      props.push(`<D:creationdate>${isoDate(e.ctime || e.mtime)}</D:creationdate>`);
      if (e.etag) props.push(`<D:getetag>${escapeXml(e.etag)}</D:getetag>`);
      props.push(supportedLockXml());
      props.push(activeLockXml(e.lock, e.href));
    }

    parts.push(
      `<D:response><D:href>${href}</D:href>` +
        '<D:propstat><D:prop>' +
        props.join('') +
        '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
        '</D:response>'
    );
  }

  parts.push('</D:multistatus>');
  return parts.join('');
}

/** LOCK 成功响应体 */
export function buildLockResponse(lock, href) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<D:prop xmlns:D="${DAV_NS}">` +
    activeLockXml(lock, href) +
    '</D:prop>'
  );
}

/**
 * 从 PROPPATCH 请求体里抽出属性列表（带命名空间）。
 * 返回 [{ prefix, local, ns }]
 */
export function parsePropSpecs(xml) {
  if (!xml || typeof xml !== 'string') return [];

  const nsMap = new Map();
  const nsRe = /xmlns:([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = nsRe.exec(xml))) nsMap.set(m[1], m[2]);

  const skipLocal = new Set([
    'propfind',
    'prop',
    'allprop',
    'propname',
    'propertyupdate',
    'set',
    'remove',
    'lockinfo',
    'lockscope',
    'locktype',
    'owner',
    'href',
    'multistatus',
    'response',
    'propstat',
    'status',
  ]);

  const seen = new Set();
  const specs = [];
  const tagRe = /<([A-Za-z0-9_-]+):([A-Za-z0-9_.-]+)[\s/>]/g;
  while ((m = tagRe.exec(xml))) {
    const prefix = m[1];
    const local = m[2];
    if (skipLocal.has(local.toLowerCase())) continue;
    const key = prefix + ':' + local;
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push({ prefix, local, ns: nsMap.get(prefix) || '' });
  }
  return specs;
}

/**
 * PROPPATCH 的 207 响应体。
 * 每个属性用独立前缀并自带 xmlns 声明，保证命名空间与请求一致
 * （Windows 的 Win32* / macOS 的 custom 属性都能被客户端认可）。
 */
export function buildProppatchResponse(href, specs) {
  const props = specs.length
    ? specs
        .map(
          (s, i) =>
            `<X${i}:${escapeXml(s.local)} xmlns:X${i}="${escapeXml(s.ns || DAV_NS)}"/>`
        )
        .join('')
    : '<D:getlastmodified/>';

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<D:multistatus xmlns:D="${DAV_NS}">` +
    `<D:response><D:href>${escapeXml(href)}</D:href>` +
    '<D:propstat><D:prop>' +
    props +
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
    '</D:response></D:multistatus>'
  );
}

/** 是否为 propname 请求 */
export function isPropnameRequest(xml) {
  return typeof xml === 'string' && /<\s*([A-Za-z0-9_-]+:)?propname\s*\/?>/i.test(xml);
}

/** 取 LOCK 请求体里的 owner 文本 */
export function parseLockOwner(xml) {
  if (typeof xml !== 'string') return '';
  const m = /<\s*(?:[A-Za-z0-9_-]+:)?owner\s*>([\s\S]*?)<\s*\/\s*(?:[A-Za-z0-9_-]+:)?owner\s*>/i.exec(xml);
  if (!m) return '';
  return m[1].replace(/<[^>]*>/g, '').trim().slice(0, 256);
}

/** 深度归一化 */
export function parseDepth(value, fallback = 'infinity') {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '0') return '0';
  if (v === '1') return '1';
  if (v === 'infinity') return 'infinity';
  return fallback;
}
