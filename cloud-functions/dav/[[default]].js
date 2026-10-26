// EdgeOne 路由：/dav/**
// 捕获 /dav 之下的多级路径（/dav/a/b/c 等）。自定义方法（PROPFIND/MKCOL/MOVE...）
// 会被平台原样转发到 onRequest，因此这里不需要按方法拆分导出。
import { createEntry } from './_lib/entry.js';

export default createEntry();
