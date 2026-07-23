/**
 * Runtime tests for @absolutejs/beacon (under happy-dom).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  BEACON_ATTRIBUTE,
  BEACON_TRACE_HEADER,
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

  test("captureException preserves trace and span correlation", async () => {
    const { beacon, sent } = make();
    track(beacon);
    beacon.captureException(new Error("correlated"), {
      spanId: "0123456789abcdef",
      traceId: "0123456789abcdef0123456789abcdef",
    });
    await beacon.flush();
    expect(sent[0]?.events[0]).toMatchObject({
      spanId: "0123456789abcdef",
      traceId: "0123456789abcdef0123456789abcdef",
    });
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

  test("preserves nested error causes in the stack and structured extra", async () => {
    const { beacon, sent } = make();
    track(beacon);
    const postgresError = Object.assign(new Error("connection terminated"), {
      code: "57P01",
      severity: "FATAL",
    });
    const queryError = new Error("Failed query", { cause: postgresError });
    beacon.captureException(queryError, { extra: { operation: "reapStuck" } });
    await beacon.flush();

    const event = sent[0]?.events[0];
    expect(event?.stack).toContain("Caused by: Error: connection terminated");
    expect(event?.extra?.operation).toBe("reapStuck");
    expect(event?.extra?.errorCauses).toEqual([
      expect.objectContaining({
        message: "connection terminated",
        name: "Error",
        properties: expect.objectContaining({
          code: "57P01",
          severity: "FATAL",
        }),
        stack: expect.stringContaining("Error: connection terminated"),
      }),
    ]);
  });

  test("preserves cross-realm cause chains and terminates circular chains", async () => {
    const { beacon, sent } = make();
    track(beacon);
    const cause: {
      cause?: unknown;
      message: string;
      name: string;
      stack: string;
    } = {
      message: "driver failed",
      name: "DriverError",
      stack: "DriverError: driver failed\n    at driver.js:2:1",
    };
    cause.cause = cause;
    beacon.captureException({
      cause,
      message: "query failed",
      name: "QueryError",
      stack: "QueryError: query failed\n    at query.js:1:1",
    });
    await beacon.flush();

    expect(sent[0]?.events[0]?.extra?.errorCauses).toEqual([
      expect.objectContaining({
        message: "driver failed",
        name: "DriverError",
      }),
      {
        message: "Cause chain references an earlier error",
        name: "CircularErrorCause",
      },
    ]);
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
  test("reports rage clicks only after repeated clicks on one unresponsive control", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true },
        project: "web",
        signals: { deadClicks: false, rageClickCount: 3 },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const button = document.createElement("button");
    document.body.append(button);
    for (let count = 0; count < 3; count += 1) {
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();
    expect(sent[0]?.events).toHaveLength(1);
    expect(sent[0]?.events[0]).toMatchObject({
      level: "warning",
      tags: { signal: "rage_click", target: "button" },
    });
    expect(sent[0]?.events[0]?.message).toEndWith(" — about:blank — button");
    button.remove();
  });

  test("does not report rapid clicks when the control responds", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true },
        project: "web",
        signals: { deadClicks: false, rageClickCount: 3 },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const button = document.createElement("button");
    let page = 0;
    button.addEventListener("click", () => {
      page += 1;
      button.dataset.page = String(page);
    });
    document.body.append(button);
    for (let count = 0; count < 3; count += 1) {
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();
    expect(sent).toHaveLength(0);
    button.remove();
  });

  test("recognizes property-only form updates as a click response", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true },
        project: "web",
        signals: { deadClicks: true, rageClicks: false },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const form = document.createElement("form");
    const input = document.createElement("input");
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", () => {
      input.value = "suggested target";
    });
    form.append(input, button);
    document.body.append(form);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();
    expect(input.getAttribute("value")).toBeNull();
    expect(input.value).toBe("suggested target");
    expect(sent).toHaveLength(0);
    form.remove();
  });

  test("does not combine nearby unresponsive controls into a rage click", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true },
        project: "web",
        signals: { deadClicks: false, rageClickCount: 3 },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    for (const button of [first, second, first]) {
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();
    expect(sent).toHaveLength(0);
    first.remove();
    second.remove();
  });

  test("does not report active pressed or selected controls as dead clicks", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true },
        project: "web",
        signals: { deadClicks: true, rageClicks: false },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const pressed = document.createElement("button");
    pressed.setAttribute("aria-pressed", "true");
    const selected = document.createElement("button");
    selected.setAttribute("role", "tab");
    selected.setAttribute("aria-selected", "true");
    document.body.append(pressed, selected);

    pressed.click();
    selected.click();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();

    expect(sent).toHaveLength(0);
    pressed.remove();
    selected.remove();
  });

  test("does not report controls marked as externally handled", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true },
        project: "web",
        signals: { deadClicks: true, rageClicks: false },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const button = document.createElement("button");
    button.setAttribute(BEACON_ATTRIBUTE.DEAD_CLICK, "ignore");
    document.body.append(button);

    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();

    expect(sent).toHaveLength(0);
    button.remove();
  });

  test("separates dead-click issues by stable control name", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true },
        project: "web",
        signals: { deadClicks: true, rageClicks: false },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const save = document.createElement("button");
    save.setAttribute(BEACON_ATTRIBUTE.NAME, "save-profile");
    const remove = document.createElement("button");
    remove.setAttribute(BEACON_ATTRIBUTE.NAME, "remove-profile");
    document.body.append(save, remove);

    save.click();
    remove.click();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();

    expect(sent[0]?.events.map(({ message }) => message)).toEqual([
      "Dead click — control didn't respond — about:blank — button[save-profile]",
      "Dead click — control didn't respond — about:blank — button[remove-profile]",
    ]);
    expect(sent[0]?.events.map(({ tags }) => tags?.target)).toEqual([
      "button[save-profile]",
      "button[remove-profile]",
    ]);
    save.remove();
    remove.remove();
  });

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

  test("resourceErrors can downgrade and group an expected resource failure", async () => {
    const sent: BeaconEnvelope[] = [];
    const failures: Array<{
      crossOrigin: boolean;
      target: string;
      type: string;
      url?: string;
    }> = [];
    const beacon = track(
      createBeacon({
        instrument: {
          globalErrors: true,
          resourceErrors: (failure) => {
            failures.push(failure);
            return failure.type === "img" && failure.crossOrigin
              ? "warning"
              : "error";
          },
        },
        project: "web",
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const image = document.createElement("img");
    image.className = "profile-photo";
    image.src = "https://images.example.com/profile.jpg";
    document.body.append(image);
    image.dispatchEvent(new Event("error"));
    await beacon.flush();
    expect(failures).toEqual([
      {
        crossOrigin: true,
        target: "img.profile-photo",
        type: "img",
        url: "https://images.example.com/profile.jpg",
      },
    ]);
    expect(sent[0]?.events[0]).toMatchObject({
      level: "warning",
      message: "Failed to load img resource from images.example.com",
      name: "ResourceLoadWarning",
      tags: {
        resourceTarget: "img.profile-photo",
        resourceType: "img",
        resourceUrl: "https://images.example.com/profile.jpg",
      },
    });
    image.remove();
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

  test("correlates fetch 5xx signals with the server trace", async () => {
    const originalFetch = globalThis.fetch;
    const traceId = "0123456789abcdef0123456789abcdef";
    globalThis.fetch = (async () =>
      new Response(null, {
        headers: { [BEACON_TRACE_HEADER]: traceId },
        status: 503,
      })) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, fetch: true },
        project: "web",
        signals: { serverErrors: true },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );

    await fetch(
      new Request("https://example.test/v1/deals", { method: "POST" }),
    );
    await beacon.flush();

    expect(sent[0]?.events[0]).toMatchObject({
      message: "Server error response (5xx)",
      tags: {
        endpoint: "https://example.test/v1/deals",
        method: "POST",
        signal: "http_5xx",
        status: "503",
      },
      traceId,
    });
    globalThis.fetch = originalFetch;
  });

  test("preserves actionable context for an isolated fetch failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, fetch: true },
        project: "web",
        signals: { failedRequests: true },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );

    await fetch("/v1/deals", { method: "POST" }).catch(() => undefined);
    await beacon.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(1);
    expect(sent[0]?.events[0]).toMatchObject({
      message: "Network request failed — POST /v1/deals",
      tags: {
        attemptCount: "1",
        endpoint: "/v1/deals",
        endpointCount: "1",
        endpoints: "/v1/deals",
        failureKind: "transport",
        method: "POST",
        signal: "fetch_failed",
        transport: "fetch",
      },
    });
    expect(sent[0]?.events[0]?.extra?.networkFailures).toEqual([
      expect.objectContaining({
        durationMs: expect.any(Number),
        endpoint: "/v1/deals",
        error: expect.objectContaining({
          message: "Failed to fetch",
          name: "TypeError",
          stack: expect.stringContaining("TypeError: Failed to fetch"),
        }),
        method: "POST",
        online: expect.any(Boolean),
        transport: "fetch",
        visibilityState: expect.any(String),
      }),
    ]);
    globalThis.fetch = originalFetch;
  });

  test("aggregates a concurrent connectivity interruption without losing attempts", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, fetch: true },
        project: "web",
        signals: { failedRequests: true },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );

    await Promise.allSettled([
      fetch("/v1/support/list"),
      fetch("/v1/notifications"),
    ]);
    await beacon.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(1);
    expect(sent[0]?.events[0]).toMatchObject({
      message: "Network connectivity interruption",
      tags: {
        attemptCount: "2",
        endpointCount: "2",
        endpoints: "/v1/support/list,/v1/notifications",
        failureKind: "transport",
        method: "GET",
        signal: "fetch_failed",
        transport: "fetch",
      },
    });
    expect(sent[0]?.events[0]?.extra?.networkFailures).toEqual([
      expect.objectContaining({ endpoint: "/v1/support/list" }),
      expect.objectContaining({ endpoint: "/v1/notifications" }),
    ]);
    globalThis.fetch = originalFetch;
  });

  test("classifies browser-offline failures separately", async () => {
    const originalFetch = globalThis.fetch;
    const onlineDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "onLine",
    );
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, fetch: true },
        project: "web",
        signals: { failedRequests: true },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );

    await fetch("/v1/deals").catch(() => undefined);
    if (onlineDescriptor === undefined)
      Reflect.deleteProperty(navigator, "onLine");
    else Object.defineProperty(navigator, "onLine", onlineDescriptor);
    await beacon.flush();

    expect(sent[0]?.events[0]).toMatchObject({
      message: "Browser offline — network requests failed",
      tags: {
        failureKind: "offline",
        online: "false",
        signal: "fetch_failed",
      },
    });
    expect(sent[0]?.events[0]?.extra?.networkFailures).toEqual([
      expect.objectContaining({ online: false }),
    ]);
    globalThis.fetch = originalFetch;
  });

  test("keeps aborted fetches as breadcrumbs instead of issues", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    }) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, fetch: true },
        project: "web",
        signals: { failedRequests: true },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );

    await fetch("/v1/notifications/stream").catch(() => undefined);
    await beacon.flush();

    expect(sent).toHaveLength(0);
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
