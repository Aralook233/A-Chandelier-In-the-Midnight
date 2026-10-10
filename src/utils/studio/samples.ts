// 采样：导入、IndexedDB 持久化、按上下文解码。
//
// 为什么不把采样做成仓库里的文件：CSP 是 script-src 'self'，站点也没有音频仓，
// 而且把别人的录音提交进 public 目录等于替用户分发。采样一律来自用户自己的文件，
// 解码后的 AudioBuffer 只活在内存里，磁盘上存的是原始字节 + 元数据。
//
// 解码结果按 BaseAudioContext 分开缓存：实时播放用 AudioContext，
// 离线导出得用 OfflineAudioContext 重新解一份，两者不能互换。

import type { SampleMeta, StoredSample } from './types';

const DATABASE = 'chandelier-studio';
const STORE = 'samples';
const VERSION = 1;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_SAMPLES = 48;

const accepted = /\.(wav|mp3|ogg|oga|m4a|aac|flac|opus|webm)$/i;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id' });
    });
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('打不开采样库')));
    request.addEventListener('blocked', () => reject(new Error('采样库被其它标签页占用')));
  });
}

async function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const handle = database.transaction(STORE, mode);
      const request = run(handle.objectStore(STORE));
      request.addEventListener('success', () => resolve(request.result as T));
      request.addEventListener('error', () => reject(request.error ?? new Error('采样库操作失败')));
      handle.addEventListener('abort', () => reject(new Error('采样库事务被中止')));
    });
  } finally {
    database.close();
  }
}

// decodeAudioData 有两套签名：Promise 版和回调版。老 Safari 只认回调版，
// 所以回调照传，同时如果拿到 Promise 也接上，两条路都走得通。
function decode(context: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const attempt = context.decodeAudioData(
      data.slice(0),
      (buffer) => resolve(buffer),
      (error) => reject(error instanceof Error ? error : new Error('解码失败'))
    ) as unknown as Promise<AudioBuffer> | undefined;
    if (attempt && typeof attempt.then === 'function') attempt.then(resolve, reject);
  });
}

export type ImportResult = { added: SampleMeta[]; rejected: string[] };

export type Samples = {
  metas: () => SampleMeta[];
  ready: () => boolean;
  // 只把记录从 IndexedDB 读进内存，不解码：解码要等 AudioContext，而启动时还没有用户手势。
  hydrate: () => Promise<number>;
  load: (context: BaseAudioContext) => Promise<{ loaded: number; failed: string[] }>;
  importFiles: (context: BaseAudioContext, files: File[]) => Promise<ImportResult>;
  drop: (id: string) => Promise<void>;
  bufferFor: (context: BaseAudioContext, id: string) => AudioBuffer | undefined;
  prepare: (context: BaseAudioContext, ids: string[]) => Promise<void>;
};

export function createSamples(): Samples {
  const stored = new Map<string, StoredSample>();
  const caches = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
  let list: SampleMeta[] = [];
  let loaded = false;
  let read = false;

  const cacheFor = (context: BaseAudioContext): Map<string, AudioBuffer> => {
    let cache = caches.get(context);
    if (!cache) {
      cache = new Map();
      caches.set(context, cache);
    }
    return cache;
  };

  const publish = () => {
    list = [...stored.values()]
      .map(({ id, name, duration, bytes }) => ({ id, name, duration, bytes }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  };

  const bad: string[] = [];

  const readAll = async (): Promise<string[]> => {
    if (read) return [];
    read = true;
    try {
      for (const sample of await inStore<StoredSample[]>('readonly', (store) => store.getAll())) {
        if (!sample?.id || !(sample.data instanceof ArrayBuffer)) {
          bad.push(sample?.name ?? '残缺记录');
          continue;
        }
        stored.set(sample.id, sample);
      }
    } catch (error) {
      read = false;
      return [error instanceof Error ? error.message : '打不开采样库'];
    }
    publish();
    return bad;
  };

  // 已经删掉的采样在缓存里可能还留着：stored 是唯一真相，取之前先查它。
  const decodeInto = async (context: BaseAudioContext, id: string): Promise<void> => {
    const cache = cacheFor(context);
    if (cache.has(id) || !stored.has(id)) return;
    const sample = stored.get(id);
    if (!sample) return;
    try {
      cache.set(id, await decode(context, sample.data));
    } catch {
      // 解不出来就当这个采样不存在，别让一次导出整体失败
    }
  };

  return {
    metas: () => list,
    ready: () => loaded,

    hydrate: async () => {
      await readAll();
      return list.length;
    },

    load: async (context) => {
      const failed = await readAll();
      for (const id of [...stored.keys()]) await decodeInto(context, id);
      loaded = true;
      return { loaded: cacheFor(context).size, failed };
    },

    importFiles: async (context, files) => {
      const added: SampleMeta[] = [];
      const rejected: string[] = [];
      const cache = cacheFor(context);

      for (const file of files) {
        if (!accepted.test(file.name)) {
          rejected.push(`${file.name}：浏览器解不了这种格式`);
          continue;
        }
        if (file.size > MAX_BYTES) {
          rejected.push(`${file.name}：超过 ${Math.floor(MAX_BYTES / 1024 / 1024)} MB`);
          continue;
        }
        if (stored.size >= MAX_SAMPLES) {
          rejected.push(`${file.name}：采样已达上限 ${MAX_SAMPLES}`);
          continue;
        }
        try {
          const data = await file.arrayBuffer();
          const buffer = await decode(context, data);
          const id = `s${Math.random().toString(36).slice(2, 10)}`;
          const name = file.name.replace(/\.[^.]+$/, '').slice(0, 48) || '未命名';
          try {
            await inStore('readwrite', (store) =>
              store.put({ id, name, duration: buffer.duration, bytes: data.byteLength, data, type: file.type || '' } satisfies StoredSample)
            );
          } catch {
            // 配额满或隐私模式：本次会话仍然能播，只是下次打开要重新导入。
            rejected.push(`${name}：这次能播，但存不进本地采样库`);
          }
          stored.set(id, { id, name, duration: buffer.duration, bytes: data.byteLength, data, type: file.type || '' });
          cache.set(id, buffer);
          added.push({ id, name, duration: buffer.duration, bytes: data.byteLength });
        } catch {
          rejected.push(`${file.name}：解码失败，文件可能已损坏`);
        }
      }

      publish();
      return { added, rejected };
    },

    drop: async (id) => {
      stored.delete(id);
      publish();
      try {
        await inStore('readwrite', (store) => store.delete(id));
      } catch {
        // 内存里已经没了，磁盘上那条会在下次加载时被当作坏记录跳过
      }
    },

    bufferFor: (context, id) => (stored.has(id) ? cacheFor(context).get(id) : undefined),

    prepare: async (context, ids) => {
      for (const id of ids) await decodeInto(context, id);
    },
  };
}
