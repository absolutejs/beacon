/**
 * Runtime tests for @absolutejs/beacon (under happy-dom).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  createBeacon,
  type Beacon,
  type BeaconEnvelope,
  type BeaconOptions,
} from "../src/index";

const ALL_OFF = {
  clicks: false,
  console: false,
  fetch: false,
  globalErrors: false,
  history: false,
  unhandledRejections: false,
} as const;

const make = (
  over: Partial<BeaconOptions> = {},
): { beacon: Beacon; sent: BeaconEnvelope[] } => {
  const sent: BeaconEnvelope[] = [];
  const beacon = createBeacon({
    instrument: ALL_OFF,
    project: "web",
    transport: ({ body }) => {
      sent.push(JSON.parse(body) as BeaconEnvelope);
    },
    ...over,
  });
  return { beacon, sent };
};

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

let open: Beacon[] = [];
const track = (beacon: Beacon): Beacon => {
  open.push(beacon);
  return beacon;
};
afterEach(async () => {
  for (const beacon of open.splice(0, open.length)) await beacon.close();
});

describe("capture + transport", () => {
  test("captureException buffers + flush sends a conforming envelope", async () => {
    const { beacon, sent } = make({ environment: "prod", release: "v1" });
    track(beacon);
    beacon.captureException(new TypeError("cannot read x"));
    await beacon.flush();
    expect(sent).toHaveLength(1);
    const envelope = sent[0]!;
    expect(envelope.v).toBe(1);
    expect(envelope.project).toBe("web");
    expect(envelope.release).toBe("v1");
    expect(envelope.environment).toBe("prod");
    expect(envelope.events).toHaveLength(1);
    const event = envelope.events[0]!;
    expect(event.name).toBe("TypeError");
    expect(event.message).toBe("cannot read x");
    expect(event.level).toBe("error");
    expect(typeof event.at).toBe("number");
    expect(typeof event.stack).toBe("string");
    expect(typeof event.extra?.sessionId).toBe("string");
  });

  test("empty flush sends nothing", async () => {
    const { beacon, sent } = make();
    track(beacon);
    await beacon.flush();
    expect(sent).toHaveLength(0);
  });

  test("captureMessage with a level", async () => {
    const { beacon, sent } = make();
    track(beacon);
    beacon.captureMessage("heads up", "warning");
    await beacon.flush();
    expect(sent[0]?.events[0]).toMatchObject({
      level: "warning",
      message: "heads up",
      name: "Message",
    });
  });

  test("coerces non-Error inputs", async () => {
    const { beacon, sent } = make();
    track(beacon);
    beacon.captureException("a string");
    beacon.captureException({ message: "an object", name: "Weird" });
    await beacon.flush();
    expect(sent[0]?.events[0]?.message).toBe("a string");
    expect(sent[0]?.events[1]?.name).toBe("Weird");
  });

  test("preserves stacks from cross-realm error-like objects", async () => {
    const { beacon, sent } = make();
    track(beacon);
    beacon.captureException({
      message: "cross-realm failure",
      name: "TypeError",
      stack: "TypeError: cross-realm failure\n    at app.js:10:2",
    });
    await beacon.flush();
    expect(sent[0]?.events[0]).toMatchObject({
      message: "cross-realm failure",
      name: "TypeError",
      stack: "TypeError: cross-realm failure\n    at app.js:10:2",
    });
  });

  test("auto-flushes when maxBatch is reached", async () => {
    const { beacon, sent } = make({ maxBatch: 2 });
    track(beacon);
    beacon.captureException(new Error("a"));
    beacon.captureException(new Error("b")); // hits maxBatch → auto flush
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(2);
  });
});

describe("enrichment", () => {
  test("breadcrumbs are attached to events", async () => {
    const { beacon, sent } = make();
    track(beacon);
    beacon.addBreadcrumb({ message: "clicked save", type: "click" });
    beacon.captureException(new Error("boom"));
    await beacon.flush();
    const crumbs = sent[0]?.events[0]?.extra?.breadcrumbs as Array<{
      message: string;
    }>;
    expect(crumbs[0]?.message).toBe("clicked save");
  });

  test("setTags merges into every event", async () => {
    const { beacon, sent } = make();
    track(beacon);
    beacon.setTags({ component: "checkout" });
    beacon.captureException(new Error("boom"), { tags: { step: "pay" } });
    await beacon.flush();
    expect(sent[0]?.events[0]?.tags).toEqual({
      component: "checkout",
      step: "pay",
    });
  });

  test("setUser is attached to extra; null clears it", async () => {
    const { beacon, sent } = make();
    track(beacon);
    beacon.setUser({ id: "u_1" });
    beacon.captureException(new Error("a"));
    await beacon.flush();
    expect(sent[0]?.events[0]?.extra?.user).toEqual({ id: "u_1" });
    beacon.setUser(null);
    beacon.captureException(new Error("b"));
    await beacon.flush();
    expect(sent[1]?.events[0]?.extra?.user).toBeUndefined();
  });

  test("beforeSend can drop an event (return null)", async () => {
    const { beacon, sent } = make({
      beforeSend: (event) => (event.message === "secret" ? null : event),
    });
    track(beacon);
    beacon.captureException(new Error("secret"));
    beacon.captureException(new Error("public"));
    await beacon.flush();
    expect(sent[0]?.events).toHaveLength(1);
    expect(sent[0]?.events[0]?.message).toBe("public");
  });

  test("sampleRate 0 drops everything", async () => {
    const { beacon, sent } = make({ sampleRate: 0 });
    track(beacon);
    beacon.captureException(new Error("boom"));
    await beacon.flush();
    expect(sent).toHaveLength(0);
  });
});

describe("auto-instrumentation", () => {
  test("captures uncaught window errors", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { globalErrors: true },
        project: "web",
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("uncaught boom"),
        message: "uncaught boom",
      }),
    );
    await beacon.flush();
    expect(sent[0]?.events[0]?.message).toBe("uncaught boom");
  });

  test("preserves browser location when an uncaught error has no Error object", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { globalErrors: true },
        project: "web",
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    window.dispatchEvent(
      new ErrorEvent("error", {
        colno: 9,
        filename: "https://cdn.example.com/app.js",
        lineno: 42,
        message: "Script error.",
      }),
    );
    await beacon.flush();
    expect(sent[0]?.events[0]).toMatchObject({
      message: "Script error.",
      name: "Error",
      stack: "Error: Script error.\n    at https://cdn.example.com/app.js:42:9",
      tags: {
        errorColumn: "9",
        errorFilename: "https://cdn.example.com/app.js",
        errorLine: "42",
      },
    });
  });

  test("captures resource failures with their target and URL", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { globalErrors: true },
        project: "web",
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const script = document.createElement("script");
    script.id = "analytics";
    script.src = "/missing.js";
    document.body.append(script);
    script.dispatchEvent(new Event("error"));
    await beacon.flush();
    expect(sent[0]?.events[0]).toMatchObject({
      message: "Failed to load script resource: /missing.js",
      name: "ResourceLoadError",
      stack: "ResourceLoadError: Failed to load script resource: /missing.js",
      tags: {
        resourceTarget: "script#analytics",
        resourceType: "script",
        resourceUrl: "/missing.js",
      },
    });
    script.remove();
  });

  test("ignores unidentifiable generic error events", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { globalErrors: true },
        project: "web",
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    window.dispatchEvent(new Event("error"));
    await beacon.flush();
    expect(sent).toHaveLength(0);
  });

  test("breadcrumbs fetch calls (and skips its own ingest endpoint)", async () => {
    const originalFetch = globalThis.fetch;
    // Stub fetch so the wrapped call resolves without real network.
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        endpoint: "/ingest",
        instrument: { fetch: true },
        project: "web",
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    await fetch("/api/data");
    await fetch("/ingest"); // must NOT be breadcrumbed (feedback loop guard)
    beacon.captureException(new Error("boom"));
    await beacon.flush();
    const crumbs = (sent[0]?.events[0]?.extra?.breadcrumbs ?? []) as Array<{
      message: string;
    }>;
    const fetchCrumbs = crumbs.filter((c) => c.message.includes("/api/data"));
    expect(fetchCrumbs).toHaveLength(1);
    expect(crumbs.some((c) => c.message.includes("/ingest"))).toBe(false);
    globalThis.fetch = originalFetch;
  });

  test("close() restores wrapped globals + does a final flush", async () => {
    const before = console.error;
    const sent: BeaconEnvelope[] = [];
    const beacon = createBeacon({
      instrument: { console: true },
      project: "web",
      transport: ({ body }) => {
        sent.push(JSON.parse(body) as BeaconEnvelope);
      },
    });
    expect(console.error).not.toBe(before); // wrapped
    beacon.captureException(new Error("pending"));
    await beacon.close();
    expect(console.error).toBe(before); // restored
    expect(sent).toHaveLength(1); // final flush delivered the buffered event
  });
});

describe("SSR / no-DOM safety", () => {
  test("global helpers are no-ops before init", () => {
    // createBeacon under happy-dom returns a real beacon, but the singleton
    // helpers must not throw when nothing has been initialized.
    const mod = require("../src/index");
    expect(() => mod.captureException(new Error("x"))).not.toThrow();
    expect(mod.getBeacon()).toBeUndefined();
  });
});
