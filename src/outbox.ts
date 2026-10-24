/** Durable, bounded delivery for JSON telemetry. Call enqueue only with redacted data.
 * Server must deduplicate by id and acknowledge that id after committing storage.
 * Browser persistence is best effort: unavailable/quota-exhausted storage is reported.
 */
export type OutboxRecord = {
  id: string;
  createdAt: number;
  body: string;
  bytes: number;
};
export interface OutboxStore {
  list(): Promise<OutboxRecord[]>;
  put(record: OutboxRecord): Promise<void>;
  remove(id: string): Promise<void>;
}
export function createIndexedDBOutboxStore(
  name = "absolute-beacon-outbox",
): OutboxStore {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("pending", { keyPath: "id" });
      request.onerror = () => {
        opening = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        opening = undefined;
        reject(Error("Outbox database blocked"));
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          opening = undefined;
        };
        resolve(request.result);
      };
    }));
  const transact = async <T>(
    mode: IDBTransactionMode,
    action: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", mode),
        request = action(tx.objectStore("pending"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? request.error ?? Error("Outbox storage failed"));
    });
  };
  return {
    list: () => transact("readonly", (s) => s.getAll()),
    put: async (r) => {
      await transact("readwrite", (s) => s.put(r));
    },
    remove: async (id) => {
      await transact("readwrite", (s) => s.delete(id));
    },
  };
}
export function createMemoryOutboxStore(): OutboxStore {
  const records = new Map<string, OutboxRecord>();
  return {
    list: async () => [...records.values()],
    put: async (r) => {
      records.set(r.id, r);
    },
    remove: async (id) => {
      records.delete(id);
    },
  };
}
export function createOutbox(options: {
  store: OutboxStore;
  send: (record: OutboxRecord, signal: AbortSignal) => Promise<string>;
  now?: () => number;
  random?: () => number;
  maxItems?: number;
  maxBytes?: number;
  maxRecordBytes?: number;
  maxAgeMs?: number;
  timeoutMs?: number;
}) {
  const now = options.now ?? Date.now,
    random = options.random ?? Math.random;
  const maxItems = options.maxItems ?? 128,
    maxBytes = options.maxBytes ?? 4_000_000,
    maxRecordBytes = options.maxRecordBytes ?? 1_000_000,
    maxAge = options.maxAgeMs ?? 172800000;
  let sequence = Promise.resolve(),
    flushing: Promise<void> | null = null,
    nextAttempt = 0,
    failures = 0;
  const stats = {
    pending: 0,
    bytes: 0,
    dropped: 0,
    expired: 0,
    storageErrors: 0,
    failedAttempts: 0,
    acknowledged: 0,
    persistMs: 0,
  };
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = sequence.then(fn);
    sequence = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const prune = async () => {
    let rows = (await options.store.list()).sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
    for (const row of rows)
      if (now() - row.createdAt > maxAge) {
        await options.store.remove(row.id);
        stats.expired++;
      }
    rows = rows.filter((r) => now() - r.createdAt <= maxAge);
    let bytes = rows.reduce((n, r) => n + r.bytes, 0);
    while (rows.length > maxItems || bytes > maxBytes) {
      const row = rows.shift()!;
      await options.store.remove(row.id);
      bytes -= row.bytes;
      stats.dropped++;
    }
    stats.pending = rows.length;
    stats.bytes = bytes;
    return rows;
  };
  return {
    stats: () => ({ ...stats, nextAttempt }),
    enqueue(value: unknown, id: string = crypto.randomUUID()): Promise<string> {
      const body = JSON.stringify(value),
        bytes = new TextEncoder().encode(body).byteLength;
      if (bytes > maxRecordBytes || bytes > maxBytes)
        return Promise.reject(Error("Telemetry record exceeds outbox limit"));
      return lock(async () => {
        const started = performance.now();
        try {
          await options.store.put({ id, createdAt: now(), body, bytes });
          await prune();
          return id;
        } catch (error) {
          stats.storageErrors++;
          throw error;
        } finally {
          stats.persistMs += performance.now() - started;
        }
      });
    },
    flush(): Promise<void> {
      if (flushing) return flushing;
      if (now() < nextAttempt) return Promise.resolve();
      flushing = (async () => {
        let rows: OutboxRecord[];
        try {
          rows = await lock(prune);
        } catch {
          stats.storageErrors++;
          return;
        }
        // Bounded snapshot: newly enqueued records wait until the next flush.
        for (const row of rows) {
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const ack = await Promise.race([
              options.send(row, controller.signal),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(Error("Outbox delivery timed out"));
                }, options.timeoutMs ?? 5000);
              }),
            ]);
            if (ack !== row.id) throw Error("Unacknowledged telemetry");
            await lock(async () => {
              await options.store.remove(row.id);
              await prune();
            });
            stats.acknowledged++;
            failures = 0;
            nextAttempt = 0;
          } catch {
            stats.failedAttempts++;
            failures++;
            nextAttempt =
              now() +
              Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6)) *
                (0.75 + random() * 0.5);
            break;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      })().finally(() => {
        flushing = null;
      });
      return flushing;
    },
  };
}
