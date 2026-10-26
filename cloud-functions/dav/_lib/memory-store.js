/**
 * 内存版 store，仅用于本地测试。
 * 目录语义与 pages-blob 的 list({directories:true}) 保持一致：
 * prefix 下含更深 "/" 的 key 会折叠进 directories，其余进 blobs。
 */

export function createMemoryStore() {
  const map = new Map();

  const toBytes = (v) => {
    if (typeof v === 'string') return new TextEncoder().encode(v);
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return new TextEncoder().encode(String(v));
  };

  return {
    _map: map,
    async set(key, value) {
      map.set(String(key), toBytes(value));
    },
    async get(key, options = {}) {
      const k = String(key);
      if (!map.has(k)) return null;
      const bytes = map.get(k);
      const type = options.type || 'text';
      if (type === 'json') {
        const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      }
      if (type === 'arrayBuffer') {
        if (typeof bytes === 'string') return new TextEncoder().encode(bytes).buffer;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      if (type === 'stream') {
        const u8 = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
        return new ReadableStream({
          start(controller) {
            controller.enqueue(u8);
            controller.close();
          },
        });
      }
      return typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
    },
    async delete(key) {
      map.delete(String(key));
    },
    async list(options = {}) {
      const prefix = options.prefix ?? '';
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (!options.directories) {
        return { blobs: keys.map((key) => ({ key })), directories: [] };
      }
      const blobs = [];
      const dirs = new Set();
      for (const key of keys) {
        const rel = key.slice(prefix.length);
        const slash = rel.indexOf('/');
        if (slash >= 0) {
          const first = rel.slice(0, slash);
          if (first) dirs.add(prefix + first);
        } else if (rel) {
          blobs.push({ key });
        }
      }
      return { blobs, directories: [...dirs].sort() };
    },
  };
}
