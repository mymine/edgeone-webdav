/**
 * 存储适配层（生产实现）。
 *
 * pages-blob 的接口：
 *   store.set(key, value)          value: string | ArrayBuffer | Blob | ReadableStream
 *   store.get(key, { type })       type: 'text' | 'json' | 'arrayBuffer' | 'blob' | 'stream'
 *   store.delete(key)
 *   store.list({ prefix, directories })
 *     -> { blobs: [{ key, etag }], directories: string[] }
 *
 * 本地测试请用 memory-store.js 里的 createMemoryStore()（同接口，零依赖）。
 */

import { getStore } from '@edgeone/pages-blob';

/**
 * 创建 EdgeOne Blob 存储实例。
 * WebDAV 语义要求「写后立刻能读到」，默认使用强一致读。
 */
export function createBlobStore(name = 'webdav', { strong = true } = {}) {
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
