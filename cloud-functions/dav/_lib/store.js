/**
 * 存储适配层（生产实现）。
 *
 * 依赖以源码形式内置在 _vendor/pages-blob.cjs（即 @edgeone/pages-blob@0.0.18 的
 * dist/index.js，19 KB 单文件），因此本项目**零 npm 依赖、零安装步骤**，
 * 不会因为构建期装包失败而导致函数没被部署。
 *
 * 升级 SDK：npm pack @edgeone/pages-blob，把 dist/index.js 覆盖到
 * _vendor/pages-blob.cjs 即可（记得跑一遍 npm test）。
 *
 * SDK 接口：
 *   store.set(key, value)          value: string | ArrayBuffer | Blob | ReadableStream
 *   store.get(key, { type })       type: 'text' | 'json' | 'arrayBuffer' | 'blob' | 'stream'
 *   store.delete(key)
 *   store.list({ prefix, directories })
 *     -> { blobs: [{ key, etag }], directories: string[] }
 */

import blobModule from '../_vendor/pages-blob.cjs';

// CJS 与 ESM 的互操作兜底：正常情况默认导出就是 module.exports
const sdk =
  blobModule && typeof blobModule.getStore === 'function'
    ? blobModule
    : (blobModule && blobModule.default) || {};

const getStore = sdk.getStore;

/**
 * 创建 EdgeOne Blob 存储实例。
 * WebDAV 语义要求「写后立刻能读到」，默认使用强一致读。
 */
export function createBlobStore(name = 'webdav', { strong = true } = {}) {
  if (typeof getStore !== 'function') {
    throw new Error(
      'pages-blob SDK not loaded: check that cloud-functions/dav/_vendor/pages-blob.cjs exists'
    );
  }
  const store = getStore({
    name,
    consistency: strong ? 'strong' : 'eventual',
  });
  return wrapStore(store, strong);
}

/** 统一给 get / list 带上一致性参数，避免各处遗漏 */
export function wrapStore(raw, strong = true) {
  const consistency = strong ? 'strong' : 'eventual';
  return {
    raw,
    strong,
    async set(key, value) {
      return raw.set(key, value);
    },
    async get(key, options = {}) {
      return raw.get(key, { consistency, ...options });
    },
    async delete(key) {
      return raw.delete(key);
    },
    async list(options = {}) {
      return raw.list({ consistency, ...options });
    },
  };
}
