// EdgeOne 路由：/dav 与 /dav/
// 与 [[default]].js 共用同一份逻辑，保证 WebDAV 根（挂载点本身）可访问。
import { createEntry } from './_lib/entry.js';

export default createEntry();
