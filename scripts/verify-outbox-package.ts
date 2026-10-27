/** Exercise the public built export, not a source-relative import. */
import { strict as assert } from "node:assert";
import {
  createMemoryOutboxStore,
  createOutbox,
} from "@absolutejs/beacon/outbox";
const store = createMemoryOutboxStore();
const failed = createOutbox({
  store,
  send: async () => {
    throw Error("offline");
  },
});
await failed.enqueue({ event: "package-consumer" }, "stable-package-id");
await failed.flush();
assert.equal((await store.list())[0]?.id, "stable-package-id");
const recovered = createOutbox({ store, send: async (record) => record.id });
await recovered.flush();
assert.equal((await store.list()).length, 0);
assert.equal(recovered.stats().acknowledged, 1);
console.log(
  "Built public outbox export preserves and acknowledges queued records.",
);
