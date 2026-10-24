import { expect, test } from "bun:test";
import { createMemoryOutboxStore, createOutbox } from "../src/outbox";
test("unacknowledged records survive recreation and retry uses the same id", async () => {
  const store = createMemoryOutboxStore();
  let now = 1000,
    calls = 0;
  const first = createOutbox({
    store,
    now: () => now,
    random: () => 0.5,
    send: async () => {
      calls++;
      throw Error("offline");
    },
  });
  await first.enqueue({ event: "frame" }, "stable-id");
  await first.flush();
  await first.flush();
  expect(calls).toBe(1);
  expect((await store.list())[0]!.id).toBe("stable-id");
  const recovered = createOutbox({
    store,
    now: () => now,
    send: async (r) => r.id,
  });
  await recovered.flush();
  expect(await store.list()).toHaveLength(0);
  expect(recovered.stats().acknowledged).toBe(1);
});
test("wrong acknowledgements and concurrent flushes cannot delete or double-send", async () => {
  const store = createMemoryOutboxStore();
  let calls = 0;
  const box = createOutbox({
    store,
    send: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return "wrong";
    },
  });
  await box.enqueue({}, "expected");
  await Promise.all([box.flush(), box.flush()]);
  expect(calls).toBe(1);
  expect(await store.list()).toHaveLength(1);
});
test("count, byte, age and per-record limits are bounded and visible", async () => {
  const store = createMemoryOutboxStore();
  let now = 1;
  const box = createOutbox({
    store,
    maxItems: 2,
    maxBytes: 40,
    maxRecordBytes: 30,
    maxAgeMs: 20,
    now: () => now,
    send: async (r) => r.id,
  });
  await box.enqueue("a", "a");
  now++;
  await box.enqueue("b", "b");
  now++;
  await box.enqueue("c", "c");
  expect(box.stats().dropped).toBe(1);
  await expect(box.enqueue("x".repeat(40))).rejects.toThrow("limit");
  now = 30;
  await box.flush();
  expect(box.stats().expired).toBe(2);
  expect(await store.list()).toHaveLength(0);
});
test("a stuck transport times out without deleting its record", async () => {
  const store = createMemoryOutboxStore();
  const box = createOutbox({
    store,
    timeoutMs: 5,
    send: () => new Promise(() => {}),
  });
  await box.enqueue({});
  await box.flush();
  expect(box.stats().failedAttempts).toBe(1);
  expect(await store.list()).toHaveLength(1);
});
test("storage errors are surfaced instead of reporting a durable save", async () => {
  const store = createMemoryOutboxStore();
  store.put = async () => {
    throw Error("quota");
  };
  const box = createOutbox({ store, send: async (r) => r.id });
  await expect(box.enqueue({})).rejects.toThrow("quota");
  expect(box.stats().storageErrors).toBe(1);
});
