/**
 * WebDAV 路径处理工具。
 *
 * 约定：内部一律使用「规范化路径」——以 / 开头、无尾斜杠、无 . / .. 段，
 * 根目录表示为 "/"。存储层再把它映射成 Blob key。
 */

/** 把 URL pathname 转换成内部路径（剥离挂载前缀 base） */
export function normalizeDavPath(pathname, base = '') {
  let p = pathname || '/';

  // 剥离挂载前缀（/dav 与 /dav/xxx 都算命中，/davx 不算）
  if (base && base !== '/') {
    if (p === base) p = '/';
    else if (p.startsWith(base + '/')) p = p.slice(base.length);
  }

  // 解码百分号转义（中文 / 空格 / emoji 文件名）
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    // 非法转义时保持原样，避免整个请求 500
    decoded = p;
  }

  const segs = [];
  for (const raw of decoded.split('/')) {
    if (!raw || raw === '.') continue;
    if (raw === '..') {
      segs.pop();
      continue;
    }
    segs.push(raw);
  }
  return '/' + segs.join('/');
}

/** 拼接子路径 */
export function joinPath(parent, name) {
  if (parent === '/' || parent === '') return '/' + name;
  return parent + '/' + name;
}

/** 取父路径，根目录的父仍是根 */
export function parentOf(p) {
  if (!p || p === '/') return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** 取末段名字，根目录返回空串 */
export function baseName(p) {
  if (!p || p === '/') return '';
  return p.slice(p.lastIndexOf('/') + 1);
}

/** 从 Blob key 里去掉前缀，得到相对路径；不匹配返回 null */
export function stripPrefix(key, prefix) {
  if (typeof key !== 'string') return null;
  if (!key.startsWith(prefix)) return null;
  return key.slice(prefix.length);
}

/** 逐段编码成 href（保留 / 分隔符） */
export function encodeHref(p, trailingSlash = false) {
  const segs = String(p || '/').split('/').filter((s) => s !== '');
  let href = '/' + segs.map(encodeURIComponent).join('/');
  if (trailingSlash && href !== '/') href += '/';
  return href === '' ? '/' : href;
}

/** 把 base 与内部路径拼成对外的 href */
export function toHref(base, p, isDir) {
  const b = base && base !== '/' ? base.replace(/\/+$/, '') : '';
  const encoded = encodeHref(p, isDir);
  return b + encoded;
}

/** Windows 客户端偶尔会把路径里的 % 二次编码，这里做一次容错 */
export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
