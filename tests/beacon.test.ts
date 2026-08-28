/**
 * Runtime tests for @absolutejs/beacon (under happy-dom).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { computeFingerprint } from "@absolutejs/errors";
import {
  BEACON_ATTRIBUTE,
  BEACON_SDK_VERSION,
  BEACON_TRACE_HEADER,
  createBeacon,
  isKnownBeaconNoise,
  type Beacon,
  type BeaconEnvelope,
  type BeaconOptions,
  type WebVital,
  type WebVitalsModule,
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

const dispatchUnhandledRejection = (reason: unknown): void => {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
};

let open: Beacon[] = [];
const track = (beacon: Beacon): Beacon => {
  open.push(beacon);
  return beacon;
};
afterEach(async () => {
  for (const beacon of open.splice(0, open.length)) await beacon.close();
  // Every createBeacon in this file is one "page load" to the boot-time
  // watchdogs — clear their storage so tests don't read as a reload loop.
  sessionStorage.removeItem("beacon:reload-history-v4");
  sessionStorage.removeItem("beacon:navigation-intent-v1");
  sessionStorage.removeItem("beacon:service-worker-update-intent-v1");
  localStorage.removeItem("beacon:release-first-seen");
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
    expect(event.extra?.sdkVersion).toBe(BEACON_SDK_VERSION);
    expect(event.extra?.pageStartedAt).toBeNumber();
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

  test("captureException sends a semantic grouping key", async () => {
    const { beacon, sent } = make();
    track(beacon);
    beacon.captureException(new Error("provider failed"), {
      groupingKey: "google-ads-tag-load",
    });
    await beacon.flush();
    expect(sent[0]?.events[0]?.groupingKey).toBe("google-ads-tag-load");
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

  test("captureMessage accepts grouping and diagnostic context", async () => {
    const { beacon, sent } = make();
    track(beacon);
    beacon.captureMessage("provider failed", "warning", {
      extra: { attempt: 3 },
      groupingKey: "google-ads-tag-load",
      tags: { provider: "google" },
      traceId: "0123456789abcdef0123456789abcdef",
    });
    await beacon.flush();
    expect(sent[0]?.events[0]).toMatchObject({
      extra: { attempt: 3 },
      groupingKey: "google-ads-tag-load",
      tags: { provider: "google" },
      traceId: "0123456789abcdef0123456789abcdef",
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

describe("Core Web Vitals", () => {
  test("delivers typed release and replay context through an override transport", async () => {
    const vitals: WebVital[] = [];
    const reporters = new Map<
      string,
      (metric: {
        id: string;
        name: string;
        navigationType: string;
        rating: string;
        value: number;
      }) => void
    >();
    const register =
      (name: string) =>
      (
        report: (metric: {
          id: string;
          name: string;
          navigationType: string;
          rating: string;
          value: number;
        }) => void,
      ) =>
        reporters.set(name, report);
    const webVitals: WebVitalsModule = {
      onCLS: register("CLS"),
      onFCP: register("FCP"),
      onINP: register("INP"),
      onLCP: register("LCP"),
      onTTFB: register("TTFB"),
    };
    track(
      createBeacon({
        environment: "production",
        getReplayId: () => "replay-1",
        getTraceId: () => "11111111111111111111111111111111",
        instrument: ALL_OFF,
        project: "project-1",
        release: "release-7",
        vitals: {
          samplingRate: 0.5,
          schemaVersion: 2,
          sdkVersion: "0.4.1",
          transport: (vital) => {
            vitals.push(vital);
          },
          webVitals,
        },
      }),
    );

    reporters.get("LCP")?.({
      id: "vital-1",
      name: "LCP",
      navigationType: "navigate",
      rating: "poor",
      value: 4_500,
    });
    await tick();

    expect(vitals).toHaveLength(1);
    expect(vitals[0]).toMatchObject({
      environment: "production",
      id: "vital-1",
      name: "LCP",
      navigationType: "navigate",
      project: "project-1",
      rating: "poor",
      release: "release-7",
      replayId: "replay-1",
      samplingRate: 0.5,
      schemaVersion: 2,
      sdkVersion: "0.4.1",
      traceId: "11111111111111111111111111111111",
      value: 4_500,
    });
    expect(vitals[0]?.at).toBeNumber();
  });

  test("bounds TBT to ten seconds from FCP", async () => {
    const originalObserver = globalThis.PerformanceObserver;
    const originalGetEntriesByName = performance.getEntriesByName;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type !== "longtask") return;
        this.callback(
          {
            getEntries: () =>
              [
                { duration: 100, startTime: 500 },
                { duration: 1_000, startTime: 15_000 },
              ] as PerformanceEntry[],
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    performance.getEntriesByName = ((name: string) =>
      name === "first-contentful-paint"
        ? ([{ startTime: 100 }] as PerformanceEntry[])
        : []) as typeof performance.getEntriesByName;
    try {
      const vitals: WebVital[] = [];
      const ignore = (): void => {};
      const beacon = track(
        createBeacon({
          instrument: ALL_OFF,
          project: "web",
          vitals: {
            transport: (vital) => {
              vitals.push(vital);
            },
            webVitals: {
              onCLS: ignore,
              onFCP: ignore,
              onINP: ignore,
              onLCP: ignore,
              onTTFB: ignore,
            },
          },
        }),
      );
      window.dispatchEvent(new Event("pagehide"));
      await tick();

      expect(vitals).toHaveLength(1);
      expect(vitals[0]).toMatchObject({
        attribution: {
          measurementWindow: "FCP",
          measurementWindowMs: 10_000,
        },
        name: "TBT",
        value: 50,
      });
      await beacon.close();
    } finally {
      performance.getEntriesByName = originalGetEntriesByName;
      globalThis.PerformanceObserver = originalObserver;
    }
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

  test("redacts secrets and every URL query value after beforeSend", async () => {
    const { beacon, sent } = make({
      beforeSend: (event) => ({
        ...event,
        extra: {
          ...event.extra,
          credentials: {
            apiKey: "key-live",
            nested: { password: "hunter2" },
          },
        },
        tags: {
          ...event.tags,
          url: "/checkout?code=oauth-code&next=%2Fportal#done",
        },
      }),
    });
    track(beacon);
    beacon.addBreadcrumb({
      message: "request Authorization: Bearer abc.def.ghi",
      type: "console",
    });
    beacon.addBreadcrumb({
      message:
        "navigate /oauth/callback?state=oauth-state-canary&provider_hint=temporary-canary#done",
      type: "navigation",
    });
    beacon.captureException(
      new Error(
        "request https://storage.example.test/object?X-Amz-Signature=signed-canary&X-Amz-Credential=temporary-canary failed token=raw-token",
      ),
    );
    await beacon.flush();

    const event = sent[0]?.events[0];
    expect(event?.message).toBe(
      "request https://storage.example.test/object failed token=[REDACTED]",
    );
    expect(event?.tags?.url).toBe("/checkout");
    expect(event?.extra?.credentials).toEqual({
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    });
    expect(event?.extra?.breadcrumbs).toEqual([
      expect.objectContaining({
        message: "request Authorization: Bearer [REDACTED]",
      }),
      expect.objectContaining({
        message: "navigate /oauth/callback",
      }),
    ]);
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
    expect(sent[0]?.events[0]?.message).toEndWith(" — blank — button");
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

  test("recognizes property-only updates outside a form as a click response", async () => {
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
    const modal = document.createElement("div");
    const input = document.createElement("input");
    const button = document.createElement("button");
    button.addEventListener("click", () => {
      input.value = "generated password";
    });
    modal.append(input, button);
    document.body.append(modal);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();
    expect(input.getAttribute("value")).toBeNull();
    expect(input.value).toBe("generated password");
    expect(sent).toHaveLength(0);
    modal.remove();
  });

  test("recognizes a successful clipboard write as a click response", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    const sent: BeaconEnvelope[] = [];
    const button = document.createElement("button");
    document.body.append(button);
    try {
      const beacon = track(
        createBeacon({
          instrument: { ...ALL_OFF, clicks: true },
          project: "web",
          signals: {
            clipboardFailures: true,
            deadClicks: true,
            rageClicks: false,
          },
          transport: ({ body }) => {
            sent.push(JSON.parse(body) as BeaconEnvelope);
          },
        }),
      );
      button.addEventListener("click", () => {
        void navigator.clipboard.writeText("secret clipboard value");
      });
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await beacon.flush();
      expect(sent).toHaveLength(0);
    } finally {
      button.remove();
      if (originalClipboard === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      }
    }
  });

  test("recognizes window.open as an external click response", async () => {
    const sent: BeaconEnvelope[] = [];
    const originalOpen = window.open;
    let openCount = 0;
    window.open = (() => {
      openCount += 1;

      return window;
    }) as typeof window.open;
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
    button.addEventListener("click", () => {
      window.open("/room", "_blank", "noopener");
    });
    document.body.append(button);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();
    expect(openCount).toBe(1);
    expect(sent).toHaveLength(0);
    button.remove();
    await beacon.close();
    window.open = originalOpen;
  });

  test("recognizes opening the native share sheet as a click response", async () => {
    const originalShare = Object.getOwnPropertyDescriptor(navigator, "share");
    let resolveShare: (() => void) | undefined;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: () =>
        new Promise<void>((resolve) => {
          resolveShare = resolve;
        }),
      writable: true,
    });
    const sent: BeaconEnvelope[] = [];
    const button = document.createElement("button");
    document.body.append(button);
    try {
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
      button.addEventListener("click", () => {
        void navigator.share({ title: "Room" });
      });
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await beacon.flush();
      expect(resolveShare).toBeFunction();
      expect(sent).toHaveLength(0);
      resolveShare?.();
    } finally {
      button.remove();
      if (originalShare === undefined) {
        Reflect.deleteProperty(navigator, "share");
      } else {
        Object.defineProperty(navigator, "share", originalShare);
      }
    }
  });

  test("recognizes opening a native file picker as a click response", async () => {
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
    const input = document.createElement("input");
    input.type = "file";
    const button = document.createElement("button");
    button.addEventListener("click", () => input.click());
    document.body.append(input, button);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();
    expect(sent).toHaveLength(0);
    input.remove();
    button.remove();
    await beacon.close();
  });

  test("does not report modifier-assisted anchor navigation as a dead click", async () => {
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
    const anchor = document.createElement("a");
    anchor.href = "/room";
    anchor.addEventListener("click", (event) => event.preventDefault());
    document.body.append(anchor);
    for (const modifier of [
      "altKey",
      "ctrlKey",
      "metaKey",
      "shiftKey",
    ] as const) {
      anchor.dispatchEvent(
        new MouseEvent("click", { bubbles: true, [modifier]: true }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();
    expect(sent).toHaveLength(0);
    anchor.remove();
  });

  test("allows an SPA router's accepted lazy navigation to settle", async () => {
    const originalHref = location.href;
    location.href = "https://app.test/current";
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true },
        project: "web",
        signals: {
          deadClicks: true,
          navigationResponseMs: 1800,
          rageClicks: false,
        },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = "/lazy-route";
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      window.setTimeout(() => history.pushState(null, "", "/lazy-route"), 1600);
    });
    document.body.append(anchor);

    anchor.focus();
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1900));
    await beacon.flush();

    expect(sent).toHaveLength(0);
    anchor.remove();
    await beacon.close();
    location.href = originalHref;
  });

  test("still reports an SPA navigation that never settles", async () => {
    const originalHref = location.href;
    location.href = "https://app.test/current";
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true },
        project: "web",
        signals: {
          deadClicks: true,
          navigationResponseMs: 1600,
          rageClicks: false,
        },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = "/stalled-route";
    anchor.addEventListener("click", (event) => event.preventDefault());
    document.body.append(anchor);

    anchor.focus();
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await beacon.flush();

    expect(sent[0]?.events).toHaveLength(1);
    expect(sent[0]?.events[0]?.tags?.signal).toBe("navigation_stalled");
    anchor.remove();
    await beacon.close();
    location.href = originalHref;
  });

  test("recognizes same-millisecond fetches as a click response", async () => {
    const sent: BeaconEnvelope[] = [];
    const originalFetch = window.fetch;
    const originalNow = Date.now;
    window.fetch = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
      { preconnect: (_url: string | URL) => {} },
    );
    Date.now = () => 123;
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true, fetch: true },
        project: "web",
        signals: { deadClicks: true, rageClicks: false },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const button = document.createElement("button");
    button.addEventListener("click", () => {
      void window.fetch("/action");
    });
    document.body.append(button);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();
    expect(sent).toHaveLength(0);
    button.remove();
    await beacon.close();
    Date.now = originalNow;
    window.fetch = originalFetch;
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

  test("does not report active pressed, selected, or current controls as dead clicks", async () => {
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
    const current = document.createElement("a");
    current.href = "/current";
    current.setAttribute("aria-current", "page");
    document.body.append(pressed, selected, current);

    pressed.click();
    selected.click();
    current.click();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();

    expect(sent).toHaveLength(0);
    pressed.remove();
    selected.remove();
    current.remove();
  });

  test("still reports aria-current false controls as dead clicks", async () => {
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
    button.setAttribute("aria-current", "false");
    document.body.append(button);

    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await beacon.flush();

    expect(sent[0]?.events).toHaveLength(1);
    expect(sent[0]?.events[0]?.tags?.signal).toBe("dead_click");
    button.remove();
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
      expect.stringContaining("button[save-profile]"),
      expect.stringContaining("button[remove-profile]"),
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

  test("correlates an error with its triggering interaction", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, clicks: true, globalErrors: true },
        project: "web",
        signals: {
          deadClicks: false,
          errorClicks: true,
          rageClicks: false,
        },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const button = document.createElement("button");
    button.setAttribute(BEACON_ATTRIBUTE.NAME, "save-deal");
    document.body.append(button);
    button.click();
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("save exploded") }),
    );
    await beacon.flush();
    const events = sent.flatMap(({ events }) => events);
    const signal = events.find(({ tags }) => tags?.signal === "error_click");
    expect(signal?.tags).toMatchObject({
      actionTarget: "button[save-deal]",
      actionType: "click",
      errorName: "Error",
      target: "button[save-deal]",
    });
    expect(
      events.find(({ message }) => message === "save exploded")?.tags,
    ).toMatchObject({
      actionTarget: "button[save-deal]",
      actionType: "click",
    });
    button.remove();
  });

  test("keeps non-Error rejection reasons stackless", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { unhandledRejections: true },
        project: "web",
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    dispatchUnhandledRejection("plain rejection");
    await beacon.flush();

    expect(sent[0]?.events[0]).toMatchObject({
      extra: expect.objectContaining({ rejectionType: "string" }),
      message: "plain rejection",
      name: "UnhandledRejection",
    });
    expect(sent[0]?.events[0]).not.toHaveProperty("stack");
  });

  test("preserves an error-shaped rejection's original stack", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { unhandledRejections: true },
        project: "web",
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    dispatchUnhandledRejection({
      message: "cross-realm rejection",
      name: "RemoteError",
      stack: "RemoteError: cross-realm rejection\n    at app.js:12:4",
    });
    await beacon.flush();

    expect(sent[0]?.events[0]).toMatchObject({
      message: "cross-realm rejection",
      name: "RemoteError",
      stack: "RemoteError: cross-realm rejection\n    at app.js:12:4",
    });
  });

  test("drops known CefSharp browser-host rejection noise", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { unhandledRejections: true },
        project: "web",
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    dispatchUnhandledRejection(
      "Object Not Found Matching Id:3, MethodName:update, ParamCount:4",
    );
    await beacon.flush();

    expect(sent).toHaveLength(0);
  });

  test.each([
    ["Can't find variable: _AutofillCallbackHandler", "ReferenceError"],
    [
      "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      "TypeError",
    ],
    [
      "TypeError: undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      "Error",
    ],
  ])(
    "identifies confirmed Facebook iOS host injection noise: %s",
    (message, name) => {
      const event = { message, name };
      const facebookIos =
        "Mozilla/5.0 Mobile/21G93 Safari/604.1 [FBAN/FBIOS;FBAV/570.0.0.54.72;]";

      expect(isKnownBeaconNoise(event, facebookIos)).toBe(true);
      expect(
        isKnownBeaconNoise(
          event,
          "Mozilla/5.0 Version/17.6 Mobile Safari/604.1",
        ),
      ).toBe(false);
    },
  );

  test("preserves unrelated errors in Facebook's iOS embedded browser", () => {
    expect(
      isKnownBeaconNoise(
        { message: "Application failed", name: "Error" },
        "Mozilla/5.0 Mobile/21G93 Safari/604.1 [FBAN/FBIOS;FBAV/570.0.0.54.72;]",
      ),
    ).toBe(false);
  });

  test("identifies Instagram iOS's injected page-hide bridge failure", () => {
    const event = {
      message:
        "TypeError: undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      name: "TypeError",
      stack:
        "sendDataToNative@https://www.example.com/:1:1142\n" +
        "sendPageHideMessage@https://www.example.com/:1:3712\n" +
        "@https://www.example.com/:1:5421",
    };
    const instagramIos =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) " +
      "AppleWebKit/605.1.15 Mobile/23F84 Instagram 440.0.0.30.81 " +
      "(iPhone18,1; iOS 26_5_2; en_US; en; scale=3.00; 1206x2622; " +
      "IABMV/1; 1025609183) Safari/604.1";

    expect(isKnownBeaconNoise(event, instagramIos)).toBe(true);
    expect(
      isKnownBeaconNoise(event, "Mozilla/5.0 Mobile/23F84 Safari/604.1"),
    ).toBe(false);
  });

  test("drops Instagram iOS bridge noise through global error capture", async () => {
    const userAgentDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "userAgent",
    );
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) " +
        "AppleWebKit/605.1.15 Mobile/23G71 Instagram 439.0.0.35.60 " +
        "(iPhone15,3; iOS 26_6; en_US; en; scale=3.00; 1290x2796; " +
        "IABMV/1; 1021301964) Safari/604.1",
    });
    try {
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
      const error = new TypeError(
        "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      );
      error.stack =
        "sendDataToNative@https://www.example.com/:1:1142\n" +
        "sendPageHideMessage@https://www.example.com/:1:3712\n" +
        "@https://www.example.com/:1:5421";
      window.dispatchEvent(
        new ErrorEvent("error", {
          error,
          message: error.message,
        }),
      );
      await beacon.flush();

      expect(sent).toHaveLength(0);
    } finally {
      if (userAgentDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "userAgent");
      } else {
        Object.defineProperty(navigator, "userAgent", userAgentDescriptor);
      }
    }
  });

  test("preserves application WebKit errors in Instagram's iOS browser", () => {
    const instagramIos =
      "Mozilla/5.0 Mobile/23F84 Instagram 440.0.0.30.81 Safari/604.1";
    const message =
      "TypeError: undefined is not an object (evaluating 'window.webkit.messageHandlers')";

    expect(
      isKnownBeaconNoise(
        {
          message,
          name: "TypeError",
          stack: "submitToNative@https://www.example.com/app.js:42:9",
        },
        instagramIos,
      ),
    ).toBe(false);
    expect(
      isKnownBeaconNoise(
        {
          message,
          name: "TypeError",
          stack: "sendDataToNative@https://www.example.com/:1:1142",
        },
        instagramIos,
      ),
    ).toBe(false);
  });

  test("identifies Facebook Android's detached injected Java bridge", () => {
    expect(
      isKnownBeaconNoise({
        message: "Error invoking postMessage: Java object is gone",
        name: "Error",
        stack:
          "Error: Error invoking postMessage: Java object is gone\n" +
          "    at sendDataToNative (iabjs://navigation_performance_logger_android:1:10025)",
        tags: {
          errorFilename: "iabjs://navigation_performance_logger_android",
        },
      }),
    ).toBe(true);
  });

  test("preserves application errors with the same detached-object message", () => {
    expect(
      isKnownBeaconNoise(
        {
          message: "Error invoking postMessage: Java object is gone",
          name: "Error",
          stack:
            "Error: Error invoking postMessage: Java object is gone\n" +
            "    at sendDataToNative (https://onspark.com/app.js:10:2)",
          tags: { errorFilename: "https://onspark.com/app.js" },
        },
        "Mozilla/5.0 [FB_IAB/FB4A;FBAV/572.0.0.38.71;]",
      ),
    ).toBe(false);
  });

  test("preserves other errors from Facebook's Android performance logger", () => {
    expect(
      isKnownBeaconNoise({
        message: "Application failed",
        name: "Error",
        stack:
          "Error: Application failed\n" +
          "    at sendDataToNative (iabjs://navigation_performance_logger_android:1:10025)",
        tags: {
          errorFilename: "iabjs://navigation_performance_logger_android",
        },
      }),
    ).toBe(false);
  });

  test("drops errors whose stack is owned entirely by a browser extension", () => {
    expect(
      isKnownBeaconNoise({
        message: "Cannot read properties of undefined (reading 'M_ID')",
        name: "TypeError",
        stack:
          "TypeError: Cannot read properties of undefined (reading 'M_ID')\n" +
          "    at F (chrome-extension://extension-id/executors/200.js:1:761)\n" +
          "    at X (chrome-extension://extension-id/executors/200.js:1:1442)",
      }),
    ).toBe(true);
  });

  test("does not synthesize an error-click for a filtered extension error", async () => {
    const { beacon, sent } = make({
      instrument: { ...ALL_OFF, clicks: true, globalErrors: true },
      signals: { errorClicks: true },
    });
    track(beacon);
    const button = document.createElement("button");
    document.body.append(button);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const error = new TypeError("Cannot read properties of undefined");
    error.stack =
      "TypeError: Cannot read properties of undefined\n" +
      "    at F (chrome-extension://extension-id/executors/200.js:1:761)\n" +
      "    at X (chrome-extension://extension-id/executors/200.js:1:1442)";
    window.dispatchEvent(
      new ErrorEvent("error", { error, message: error.message }),
    );
    await beacon.flush();

    expect(sent).toHaveLength(0);
    button.remove();
  });

  test("preserves application errors with a mixed extension and app stack", () => {
    expect(
      isKnownBeaconNoise({
        message: "Application failed",
        name: "Error",
        stack:
          "Error: Application failed\n" +
          "    at injected (chrome-extension://extension-id/content.js:1:1)\n" +
          "    at save (https://example.com/app.js:20:4)",
      }),
    ).toBe(false);
  });

  test("drops extension-injected fetch failures with mixed page frames", () => {
    expect(
      isKnownBeaconNoise({
        message: "Failed to fetch",
        name: "TypeError",
        stack:
          "TypeError: Failed to fetch\n" +
          "    at wrapped (chrome-extension://extension-id/requests.js:1:4)\n" +
          "    at send (https://www.googletagmanager.com/gtag/js:1:2)",
      }),
    ).toBe(true);
  });

  test("preserves application fetch failures when an extension is not the origin", () => {
    expect(
      isKnownBeaconNoise({
        message: "Failed to fetch",
        name: "TypeError",
        stack:
          "TypeError: Failed to fetch\n" +
          "    at save (https://example.com/app.js:20:4)\n" +
          "    at injected (chrome-extension://extension-id/content.js:1:1)",
      }),
    ).toBe(false);
  });

  test("identifies Google Web Renderer service-worker registration rejection", () => {
    expect(
      isKnownBeaconNoise({
        message: "Rejected",
        name: "Error",
        stack:
          "Error: Rejected\n" +
          "    at wrsParams.serviceWorkers.navigator.serviceWorker.register (<anonymous>:460:195)",
      }),
    ).toBe(true);
  });

  test("identifies masked scanner service-worker wrapper rejection", () => {
    expect(
      isKnownBeaconNoise({
        message: "Rejected",
        name: "Error",
        stack:
          "Error: Rejected\n" +
          "    at ServiceWorkerContainer.<anonymous> (<anonymous>:669:449)\n" +
          "    at ServiceWorkerContainer.register (<anonymous>:460:195)",
      }),
    ).toBe(true);
  });

  test.each([
    {
      message: "Rejected",
      name: "Error",
      stack:
        "Error: Rejected\n    at register (https://example.com/app.js:20:4)",
    },
    {
      message: "The operation is insecure.",
      name: "SecurityError",
      stack:
        "SecurityError: The operation is insecure.\n" +
        "    at ServiceWorkerContainer.register (https://example.com/app.js:20:4)",
    },
    {
      message: "The operation was aborted.",
      name: "AbortError",
      stack:
        "AbortError: The operation was aborted.\n" +
        "    at ServiceWorkerContainer.register (https://example.com/app.js:20:4)",
    },
  ])("preserves application and native service-worker failures", (event) => {
    expect(isKnownBeaconNoise(event)).toBe(false);
  });

  test.each([
    "Mozilla/5.0 (compatible; AdsBot-Google/2.1; +http://www.google.com/adsbot.html)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; BitSightBot/1.0)",
    "Mozilla/5.0 Dataprovider.com",
    "Mozilla/5.0 Google-NotebookLM",
    "Mozilla/5.0 (compatible; HubSpot Crawler; +https://www.hubspot.com/)",
    "Mozilla/5.0 (compatible; meta-externalagent/1.1; +https://developers.facebook.com/docs/sharing/webmasters/crawler)",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1 (compatible; meta-externalads/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))",
  ])("drops crawler and scanner traffic: %s", (userAgent) => {
    expect(
      isKnownBeaconNoise(
        { message: "Application failed", name: "Error" },
        userAgent,
      ),
    ).toBe(true);
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
      tags: {
        resourceTarget: "script#analytics",
        resourceType: "script",
        resourceUrl: "/missing.js",
      },
    });
    expect(sent[0]?.events[0]).not.toHaveProperty("stack");
    script.remove();
  });

  test("resource failures stay stackless when the browser exposes an inherited stack", async () => {
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
    script.src = "/missing.js";
    document.body.append(script);
    const inheritedStack = Object.getOwnPropertyDescriptor(
      Error.prototype,
      "stack",
    );
    try {
      Object.defineProperty(Error.prototype, "stack", {
        configurable: true,
        get: () => "ResourceLoadError: synthetic\n    at beacon.js:1:1",
      });
      script.dispatchEvent(new Event("error"));
    } finally {
      if (inheritedStack === undefined) delete Error.prototype.stack;
      else Object.defineProperty(Error.prototype, "stack", inheritedStack);
    }
    await beacon.flush();
    expect(sent[0]?.events[0]).toMatchObject({
      message: "Failed to load script resource: /missing.js",
      name: "ResourceLoadError",
    });
    expect(sent[0]?.events[0]).not.toHaveProperty("stack");
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
    expect(sent[0]?.events[0]).not.toHaveProperty("stack");
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

  test("classifies semantic failures in successful fetch responses", async () => {
    const originalFetch = window.fetch;
    window.fetch = (async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "resolver failed" }] }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      )) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: {
          ...ALL_OFF,
          classifyResponse: async (response, request) => {
            if (!request.url.includes("/graphql")) return false;
            const body = (await response.json()) as { errors?: unknown[] };
            return body.errors?.length
              ? {
                  groupingKey: "graphql:resolver-failure",
                  message: "GraphQL response contained errors",
                }
              : false;
          },
          fetch: true,
        },
        project: "web",
        signals: true,
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    try {
      await window.fetch("/graphql");
      await tick();
      await beacon.flush();
      const event = sent
        .flatMap(({ events }) => events)
        .find(({ tags }) => tags?.signal === "semantic_response_failure");
      expect(event).toMatchObject({
        groupingKey: "graphql:resolver-failure",
        tags: { endpoint: "/graphql", method: "GET" },
      });
    } finally {
      await beacon.close();
      window.fetch = originalFetch;
    }
  });

  test("opt-in classifies selected 4xx fetch responses", async () => {
    const originalFetch = window.fetch;
    const traceId = "fedcba9876543210fedcba9876543210";
    window.fetch = (async () =>
      new Response(
        JSON.stringify({
          errorCode: "E_INVALID_SUBMISSION",
          message: "The provided data is invalid.",
        }),
        {
          headers: {
            [BEACON_TRACE_HEADER]: traceId,
            "content-type": "application/json",
          },
          status: 422,
        },
      )) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: {
          ...ALL_OFF,
          classifyErrorResponse: async (response, request) => {
            if (!request.url.includes("/payments")) return false;
            const body = (await response.json()) as { errorCode?: string };
            return body.errorCode === "E_INVALID_SUBMISSION"
              ? {
                  groupingKey: "payments:provider-contract",
                  level: "error",
                  message: "Payment provider rejected the request contract",
                  tags: { providerCode: body.errorCode },
                }
              : false;
          },
          fetch: true,
        },
        project: "web",
        signals: false,
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    try {
      await window.fetch("/v1/payments/subscriptions", { method: "POST" });
      await tick();
      await beacon.flush();
      expect(sent[0]?.events[0]).toMatchObject({
        groupingKey: "payments:provider-contract",
        level: "error",
        message: "Payment provider rejected the request contract",
        name: "HttpResponseFailure",
        tags: {
          endpoint: "/v1/payments/subscriptions",
          method: "POST",
          providerCode: "E_INVALID_SUBMISSION",
          signal: "http_response_failure",
          status: "422",
        },
        traceId,
      });
    } finally {
      await beacon.close();
      window.fetch = originalFetch;
    }
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
      message: "Server error response (5xx) — POST /v1/deals",
      tags: {
        endpoint: "/v1/deals",
        method: "POST",
        signal: "http_5xx",
        status: "503",
      },
      traceId,
    });
    globalThis.fetch = originalFetch;
  });

  test("groups response signals by method and query-free endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, fetch: true },
        project: "web",
        signals: { serverErrors: true, slowResponseMs: -1 },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );

    await fetch("/v1/deals?token=secret", { method: "post" });
    await beacon.flush();

    expect(sent[0]?.events[0]).toMatchObject({
      message: "Slow response — POST /v1/deals",
      tags: {
        endpoint: "/v1/deals",
        method: "POST",
        signal: "slow_response",
      },
    });
    expect(sent[0]?.events[0]?.message).not.toContain("secret");
    globalThis.fetch = originalFetch;
  });

  test("reports HTTP 429 responses as rate limiting", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 429 })) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, fetch: true },
        project: "web",
        signals: { rateLimits: true },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );

    await fetch("/v1/search", { method: "POST" });
    await beacon.flush();

    expect(sent[0]?.events[0]).toMatchObject({
      message: "Rate limited — POST /v1/search returned 429",
      tags: {
        endpoint: "/v1/search",
        method: "POST",
        signal: "rate_limited",
        status: "429",
      },
    });
    globalThis.fetch = originalFetch;
  });

  test("reports repeated authorization failures without flagging one rejection", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 401 })) as unknown as typeof fetch;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, fetch: true },
        project: "web",
        signals: { authFailureStormCount: 3 },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );

    await fetch("/v1/session");
    await beacon.flush();
    expect(sent).toHaveLength(0);
    await fetch("/v1/session");
    await fetch("/v1/session");
    await beacon.flush();

    expect(sent[0]?.events[0]).toMatchObject({
      tags: {
        endpoint: "/v1/session",
        failureCount: "3",
        method: "GET",
        signal: "auth_failure_storm",
        statuses: "401",
      },
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

  test("keeps extension-injected fetch failures as breadcrumbs only", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const error = new TypeError("Failed to fetch");
      error.stack =
        "TypeError: Failed to fetch\n" +
        "    at wrapped (chrome-extension://extension-id/requests.js:1:4)\n" +
        "    at load (https://app.example/assets/app.js:20:2)";
      throw error;
    }) as unknown as typeof fetch;
    const { beacon, sent } = make({
      instrument: { ...ALL_OFF, fetch: true },
      signals: { failedRequests: true },
    });
    track(beacon);

    await fetch("/v1/deals").catch(() => undefined);
    await beacon.flush();

    expect(sent).toHaveLength(0);
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
        endpoints: "/v1/notifications,/v1/support/list",
        failureKind: "transport",
        method: "GET",
        reportDelayMs: expect.any(String),
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

  test("uses stable identity for connectivity interruptions", async () => {
    const originalFetch = globalThis.fetch;
    const capture = async (paths: string[]) => {
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
      await Promise.allSettled(paths.map((path) => fetch(path)));
      await beacon.flush();

      return sent[0]?.events[0];
    };

    try {
      const first = await capture(["/v1/support/list", "/v1/notifications"]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await capture(["/v1/notifications", "/v1/support/list"]);
      expect(first?.tags?.endpoints).toBe("/v1/notifications,/v1/support/list");
      expect(second?.tags?.endpoints).toBe(first?.tags?.endpoints);
      expect(second?.groupingKey).toBe(first?.groupingKey);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps a suspended hidden-tab transport burst as breadcrumb-only context", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    let now = 1_000;
    Date.now = () => now;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
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

    await Promise.allSettled([
      fetch("/v1/admin/issues"),
      fetch("/v1/notifications"),
    ]);
    now += 60_000;
    await beacon.flush();
    expect(sent).toHaveLength(0);

    beacon.captureException(new Error("later application failure"));
    await beacon.flush();
    expect(sent[0]?.events[0]?.extra?.breadcrumbs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ reportDelayMs: 60_000 }),
          message: "Suppressed stale background network interruption",
          type: "fetch",
        }),
      ]),
    );

    Date.now = originalNow;
    if (visibilityDescriptor === undefined)
      Reflect.deleteProperty(document, "visibilityState");
    else
      Object.defineProperty(document, "visibilityState", visibilityDescriptor);
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

  test("suppresses generic transport failures during page teardown", async () => {
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

    // A failure already queued when navigation starts must be discarded.
    await fetch("/v1/invoices").catch(() => undefined);
    window.dispatchEvent(new Event("pagehide"));
    // A browser rejection delivered after pagehide must also stay a breadcrumb.
    await fetch("/v1/notifications").catch(() => undefined);
    await beacon.flush();

    expect(sent).toHaveLength(0);

    // BFCache restoration makes subsequent genuine failures actionable again.
    window.dispatchEvent(new Event("pageshow"));
    await fetch("/v1/invoices").catch(() => undefined);
    await beacon.flush();
    expect(sent).toHaveLength(1);
    globalThis.fetch = originalFetch;
  });

  test("console error signals start their stack at the application caller", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, console: true },
        project: "web",
        signals: { consoleErrors: true },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    function applicationConsoleCaller() {
      console.error("application console failure");
    }

    applicationConsoleCaller();
    await beacon.flush();

    const stack = sent[0]?.events[0]?.stack;
    expect(sent[0]?.events[0]?.groupingKey).toBeUndefined();
    expect(stack).toContain("applicationConsoleCaller");
    expect(stack).not.toContain("emitSignal");
    expect(stack).not.toContain("wrappedConsole");
  });

  test("console errors group by normalized message and application caller", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, console: true },
        project: "web",
        signals: { consoleErrors: true },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const invitationFailure = (attempt: number) => {
      console.error(`Failed to send invitation attempt ${attempt}`);
    };
    const invitationLoadFailure = () => {
      console.error("Failed to load invitations");
    };

    invitationFailure(12);
    invitationFailure(34);
    invitationLoadFailure();
    await beacon.flush();

    const events = sent[0]?.events ?? [];
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.groupingKey === undefined)).toBeTrue();
    const fingerprints = await Promise.all(
      events.map((event) =>
        computeFingerprint({
          message: event.message,
          name: event.name,
          ...(event.stack === undefined ? {} : { stack: event.stack }),
        }),
      ),
    );
    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect(fingerprints[2]).not.toBe(fingerprints[0]);
  });

  test("console errors preserve a logged Error's original stack", async () => {
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, console: true },
        project: "web",
        signals: { consoleErrors: true },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const originalError = new TypeError("renderer failed");
    originalError.stack =
      "TypeError: renderer failed\n    at updateComponent (/app/Profile.vue:42:7)";

    console.error("[Vue warn]", originalError);
    await beacon.flush();

    const captured = sent[0]?.events[0];
    expect(captured).toMatchObject({
      level: "warning",
      message: "renderer failed",
      name: "TypeError",
      stack:
        "TypeError: renderer failed\n    at updateComponent (/app/Profile.vue:42:7)",
      tags: { signal: "console_error" },
    });
    expect(captured?.extra?.consoleMessage).toBe(
      "[Vue warn] TypeError: renderer failed",
    );
  });

  test("console stack trimming works without Error.captureStackTrace", async () => {
    const captureStackTraceDescriptor = Object.getOwnPropertyDescriptor(
      Error,
      "captureStackTrace",
    );
    Object.defineProperty(Error, "captureStackTrace", {
      configurable: true,
      value: undefined,
    });
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: { ...ALL_OFF, console: true },
        project: "web",
        signals: { consoleErrors: true },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    function applicationConsoleCaller() {
      console.error("portable console failure");
    }

    try {
      applicationConsoleCaller();
      await beacon.flush();
    } finally {
      if (captureStackTraceDescriptor !== undefined) {
        Object.defineProperty(
          Error,
          "captureStackTrace",
          captureStackTraceDescriptor,
        );
      } else {
        Reflect.deleteProperty(Error, "captureStackTrace");
      }
    }

    const stack = sent[0]?.events[0]?.stack;
    expect(stack).toContain("applicationConsoleCaller");
    expect(stack).not.toContain("emitSignal");
    expect(stack).not.toContain("wrappedConsole");
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

describe("layout-overflow signals", () => {
  const VIEWPORT_WIDTH = 1024;
  const domRect = (left: number, right: number): DOMRect =>
    ({
      bottom: 50,
      height: 50,
      left,
      right,
      toJSON: () => ({}),
      top: 0,
      width: right - left,
      x: left,
      y: 0,
    }) as DOMRect;
  const mockRect = (element: Element, rect: DOMRect): void => {
    element.getBoundingClientRect = () => rect;
  };
  const makeOverflowBeacon = (): { beacon: Beacon; sent: BeaconEnvelope[] } => {
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: VIEWPORT_WIDTH,
    });
    mockRect(document.body, domRect(0, VIEWPORT_WIDTH));
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: ALL_OFF,
        project: "web",
        signals: { layoutOverflowSettleMs: 0 },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    return { beacon, sent };
  };
  const scan = async (beacon: Beacon): Promise<void> => {
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await beacon.flush();
  };

  test("reports an in-flow element spilling past the viewport, once", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const wide = document.createElement("div");
    wide.className = "runaway-toolbar";
    mockRect(wide, domRect(0, 1300));
    document.body.append(wide);

    await scan(beacon);
    expect(sent).toHaveLength(1);
    const event = sent[0]?.events[0];
    expect(event?.tags?.signal).toBe("layout_overflow");
    expect(event?.tags?.overflowKind).toBe("viewport");
    expect(event?.tags?.spillPx).toBe("276");
    expect(event?.message).toContain("div.runaway-toolbar");
    expect(event?.message).not.toContain("276");
    expect(event?.groupingKey).toMatch(
      /^beacon-signal:layout_overflow:[0-9a-f]{16}$/,
    );

    // The same offender at the same breakpoint stays one issue.
    await scan(beacon);
    expect(sent).toHaveLength(1);
    wide.remove();
  });

  test("does not scan unstyled fallback DOM after an active stylesheet fails", async () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/missing-app.css";
    const element = document.createElement("button");
    element.className = "absolute inset-0";
    document.head.append(link);
    document.body.append(element);
    mockRect(element, domRect(0, 1_296));
    const { beacon, sent } = make({
      signals: {
        controlCollisions: true,
        layoutOverflowSettleMs: 5,
        layoutOverflows: true,
      },
    });
    track(beacon);

    await new Promise((resolve) => setTimeout(resolve, 30));
    await beacon.flush();

    expect(link.sheet).toBeNull();
    expect(
      sent.flatMap((envelope) =>
        envelope.events.filter(
          (event) => event.tags?.signal === "layout_overflow",
        ),
      ),
    ).toHaveLength(0);
    element.remove();
    link.remove();
  });

  test("does not scan when attached styles omit active layout utilities", async () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    Object.defineProperty(link, "sheet", {
      configurable: true,
      value: { cssRules: [] },
    });
    const element = document.createElement("button");
    element.className = "absolute inset-0";
    document.head.append(link);
    document.body.append(element);
    mockRect(element, domRect(0, 1_296));
    const { beacon, sent } = make({
      signals: {
        controlCollisions: true,
        layoutOverflowSettleMs: 5,
        layoutOverflows: true,
      },
    });
    track(beacon);

    await new Promise((resolve) => setTimeout(resolve, 30));
    await beacon.flush();

    expect(window.getComputedStyle(element).position).not.toBe("absolute");
    expect(
      sent.flatMap((envelope) =>
        envelope.events.filter(
          (event) => event.tags?.signal === "layout_overflow",
        ),
      ),
    ).toHaveLength(0);
    element.remove();
    link.remove();
  });

  test("pauses geometry scans while the mobile keyboard owns the viewport", async () => {
    const originalViewport = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const originalInnerHeight = Object.getOwnPropertyDescriptor(
      window,
      "innerHeight",
    );
    const viewport = Object.assign(new EventTarget(), {
      height: 450,
      offsetLeft: 69,
      offsetTop: 200,
      width: 552,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    mockRect(document.body, domRect(-69, 483));
    try {
      const { beacon, sent } = makeOverflowBeacon();
      await scan(beacon);
      expect(
        sent.flatMap((envelope) =>
          envelope.events.filter(
            (event) => event.tags?.signal === "layout_overflow",
          ),
        ),
      ).toHaveLength(0);
    } finally {
      input.remove();
      if (originalViewport === undefined) {
        Reflect.deleteProperty(window, "visualViewport");
      } else {
        Object.defineProperty(window, "visualViewport", originalViewport);
      }
      if (originalInnerHeight === undefined) {
        Reflect.deleteProperty(window, "innerHeight");
      } else {
        Object.defineProperty(window, "innerHeight", originalInnerHeight);
      }
    }
  });

  test("pauses geometry scans while iOS leaves the visual viewport horizontally shifted", async () => {
    const originalViewport = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const viewport = Object.assign(new EventTarget(), {
      height: 729,
      offsetLeft: 7,
      offsetTop: 0,
      scale: 1,
      width: 402,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 402,
    });
    mockRect(document.body, domRect(-7, 395));
    try {
      const { beacon, sent } = make({
        signals: { layoutOverflowSettleMs: 0, layoutOverflows: true },
      });
      track(beacon);
      await scan(beacon);
      expect(
        sent.flatMap((envelope) =>
          envelope.events.filter(
            (event) => event.tags?.signal === "layout_overflow",
          ),
        ),
      ).toHaveLength(0);
    } finally {
      if (originalViewport === undefined) {
        Reflect.deleteProperty(window, "visualViewport");
      } else {
        Object.defineProperty(window, "visualViewport", originalViewport);
      }
    }
  });

  test("reports an unclassed app image with privacy-safe overflow provenance", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const parent = document.createElement("figure");
    const image = document.createElement("img");
    image.setAttribute(
      "src",
      "https://assets.example.test/guide-cover.webp?member=private",
    );
    image.setAttribute("data-darkreader-inline-color", "");
    mockRect(parent, domRect(0, VIEWPORT_WIDTH));
    mockRect(image, domRect(0, 1040));
    parent.append(image);
    document.body.append(parent);

    await scan(beacon);
    expect(sent).toHaveLength(1);
    const tags = sent[0]?.events[0]?.tags;
    expect(tags?.target).toBe("img");
    expect(tags?.targetAncestor).toBe("figure");
    expect(tags?.resourceSource).toBe("assets.example.test");
    expect(tags?.targetLeftPx).toBe("0");
    expect(tags?.targetRightPx).toBe("1040");
    expect(tags?.targetWidthPx).toBe("1040");
    expect(tags?.injectionMarkers).toBe("data-darkreader-inline-color");
    expect(JSON.stringify(tags)).not.toContain("member=private");
    parent.remove();
  });

  test("does not report positively identified extension resource overflow", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const image = document.createElement("img");
    image.setAttribute("src", "chrome-extension://abc123/injected.png");
    mockRect(image, domRect(0, 1040));
    document.body.append(image);

    await scan(beacon);
    expect(sent).toHaveLength(0);
    image.remove();
  });

  test("honors the data-beacon-overflow allow escape hatch", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const bleed = document.createElement("div");
    bleed.setAttribute(BEACON_ATTRIBUTE.OVERFLOW, "allow");
    mockRect(bleed, domRect(0, 1300));
    document.body.append(bleed);

    await scan(beacon);
    expect(sent).toHaveLength(0);
    bleed.remove();
  });

  test("reports a child painting past a non-scrolling parent", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const parent = document.createElement("div");
    mockRect(parent, domRect(0, 500));
    const squeezed = document.createElement("button");
    squeezed.className = "sync-button";
    mockRect(squeezed, domRect(400, 700));
    parent.append(squeezed);
    document.body.append(parent);

    await scan(beacon);
    expect(sent).toHaveLength(1);
    const event = sent[0]?.events[0];
    expect(event?.tags?.overflowKind).toBe("container");
    expect(event?.tags?.spillPx).toBe("200");
    expect(event?.message).toContain("button.sync-button");
    parent.remove();
  });

  test("skips subtrees of intentional scrollers", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const scroller = document.createElement("div");
    scroller.style.overflowX = "auto";
    mockRect(scroller, domRect(0, 800));
    const wideChild = document.createElement("div");
    mockRect(wideChild, domRect(0, 1400));
    scroller.append(wideChild);
    document.body.append(scroller);

    await scan(beacon);
    expect(sent).toHaveLength(0);
    scroller.remove();
  });

  test("skips positioned subtrees fully outside the viewport", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const drawer = document.createElement("aside");
    drawer.style.position = "fixed";
    mockRect(drawer, domRect(-400, -100));
    const child = document.createElement("nav");
    mockRect(child, domRect(-400, -100));
    drawer.append(child);
    document.body.append(drawer);

    await scan(beacon);
    expect(sent).toHaveLength(0);
    drawer.remove();
  });

  test("does not report material icon glyph paint bounds", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const parent = document.createElement("button");
    mockRect(parent, domRect(0, 40));
    const icon = document.createElement("span");
    icon.className = "material-icons";
    mockRect(icon, domRect(0, 48));
    parent.append(icon);
    document.body.append(parent);

    await scan(beacon);
    expect(sent).toHaveLength(0);
    parent.remove();
  });

  test("does not report intentionally clipped material icon ligature text", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const icon = document.createElement("span");
    icon.className = "material-icons";
    icon.textContent = "settings";
    icon.style.overflowX = "hidden";
    mockRect(icon, domRect(0, 22));
    Object.defineProperty(icon, "scrollWidth", { value: 67 });
    Object.defineProperty(icon, "clientWidth", { value: 22 });
    document.body.append(icon);

    await scan(beacon);
    expect(sent).toHaveLength(0);
    icon.remove();
  });

  test("reports clipped content unless an ellipsis treatment owns it", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const clipped = document.createElement("div");
    clipped.className = "cut-label";
    clipped.style.overflowX = "hidden";
    mockRect(clipped, domRect(0, 200));
    Object.defineProperty(clipped, "scrollWidth", { value: 300 });
    Object.defineProperty(clipped, "clientWidth", { value: 200 });
    const truncated = document.createElement("div");
    truncated.style.overflowX = "hidden";
    truncated.style.textOverflow = "ellipsis";
    mockRect(truncated, domRect(0, 200));
    Object.defineProperty(truncated, "scrollWidth", { value: 300 });
    Object.defineProperty(truncated, "clientWidth", { value: 200 });
    document.body.append(clipped, truncated);

    await scan(beacon);
    expect(sent).toHaveLength(1);
    const event = sent[0]?.events[0];
    expect(event?.tags?.overflowKind).toBe("clipped");
    expect(event?.tags?.spillPx).toBe("100");
    expect(event?.message).toContain("div.cut-label");
    clipped.remove();
    truncated.remove();
  });

  test("ignores clipped screen-reader-only live regions", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const liveRegion = document.createElement("div");
    liveRegion.id = "announcement";
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.style.overflow = "hidden";
    liveRegion.style.position = "fixed";
    mockRect(liveRegion, { ...domRect(0, 1), bottom: 1, height: 1 });
    Object.defineProperty(liveRegion, "scrollWidth", { value: 399 });
    Object.defineProperty(liveRegion, "clientWidth", { value: 1 });
    document.body.append(liveRegion);

    await scan(beacon);
    expect(sent).toHaveLength(0);
    liveRegion.remove();
  });

  test("does not treat a vertical scrollbar gutter as clipped content", async () => {
    const { beacon, sent } = makeOverflowBeacon();
    const main = document.createElement("main");
    main.className = "main-content";
    main.style.overflowX = "hidden";
    main.style.overflowY = "auto";
    mockRect(main, domRect(240, 958));
    Object.defineProperty(main, "clientWidth", { value: 702 });
    Object.defineProperty(main, "offsetWidth", { value: 718 });
    Object.defineProperty(main, "scrollWidth", { value: 718 });
    document.body.append(main);

    await scan(beacon);
    expect(sent).toHaveLength(0);
    main.remove();
  });
});

describe("ambient watchdog signals", () => {
  const VIEWPORT_W = 1024;
  const VIEWPORT_H = 800;
  const rectOf = (left: number, right: number, top = 0, bottom = 50): DOMRect =>
    ({
      bottom,
      height: bottom - top,
      left,
      right,
      toJSON: () => ({}),
      top,
      width: right - left,
      x: left,
      y: top,
    }) as DOMRect;
  const setRect = (element: Element, rect: DOMRect): void => {
    element.getBoundingClientRect = () => rect;
  };
  const signalsSent = (
    sent: BeaconEnvelope[],
    signal: string,
  ): BeaconEnvelope["events"] =>
    sent.flatMap((envelope) =>
      envelope.events.filter((event) => event.tags?.signal === signal),
    );
  const makeWatchdogBeacon = (
    over: Partial<BeaconOptions> = {},
  ): { beacon: Beacon; sent: BeaconEnvelope[] } => {
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: VIEWPORT_W,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: VIEWPORT_H,
    });
    setRect(document.body, rectOf(0, VIEWPORT_W, 0, VIEWPORT_H));
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: ALL_OFF,
        project: "web",
        signals: { fontFailureConfirmMs: 0, layoutOverflowSettleMs: 0 },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
        ...over,
      }),
    );
    return { beacon, sent };
  };
  const settle = async (beacon: Beacon): Promise<void> => {
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await beacon.flush();
  };
  const movePointer = (x: number, y: number): void => {
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: x,
        clientY: y,
        pointerType: "mouse",
      }),
    );
  };

  test("attributes bfcache blockers without retaining URL secrets", async () => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(
      performance,
      "getEntriesByType",
    );
    const originalGetEntriesByType =
      performance.getEntriesByType.bind(performance);
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: (type: string) =>
        type === "navigation"
          ? [
              {
                notRestoredReasons: {
                  children: [
                    {
                      children: [],
                      reasons: [{ reason: "web-lock" }],
                      src: "https://video.example/embed/demo?token=secret#private",
                    },
                  ],
                  reasons: [{ reason: "unload-listener" }],
                  url: "https://app.example/deals/123e4567-e89b-42d3-a456-426614174000?member=private#section",
                },
                type: "back_forward",
              },
            ]
          : originalGetEntriesByType(type),
    });
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      const events = signalsSent(sent, "bfcache_blocked");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags).toMatchObject({
        blockerLocations:
          "https://app.example/deals/:id,https://video.example/embed/demo",
        blockerScope: "mixed",
        reasons: "unload-listener,web-lock",
      });
      expect(events[0]?.extra?.bfcacheBlockers).toEqual([
        {
          depth: 0,
          location: "https://app.example/deals/:id",
          reasons: ["unload-listener"],
        },
        {
          depth: 1,
          location: "https://video.example/embed/demo",
          reasons: ["web-lock"],
        },
      ]);
    } finally {
      if (ownDescriptor === undefined) {
        Reflect.deleteProperty(performance, "getEntriesByType");
      } else {
        Object.defineProperty(performance, "getEntriesByType", ownDescriptor);
      }
    }
  });

  test("does not report privacy-masked bfcache reasons", async () => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(
      performance,
      "getEntriesByType",
    );
    const originalGetEntriesByType =
      performance.getEntriesByType.bind(performance);
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: (type: string) =>
        type === "navigation"
          ? [
              {
                notRestoredReasons: {
                  children: [],
                  reasons: [{ reason: "masked" }],
                  url: "https://private.example/path?secret=value",
                },
                type: "back_forward",
              },
            ]
          : originalGetEntriesByType(type),
    });
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      expect(signalsSent(sent, "bfcache_blocked")).toHaveLength(0);
    } finally {
      if (ownDescriptor === undefined) {
        Reflect.deleteProperty(performance, "getEntriesByType");
      } else {
        Object.defineProperty(performance, "getEntriesByType", ownDescriptor);
      }
    }
  });

  test("ignores configured inherent bfcache reasons but keeps actionable ones", async () => {
    const originalEntries = performance.getEntriesByType.bind(performance);
    performance.getEntriesByType = ((type: string) =>
      type === "navigation"
        ? [
            {
              notRestoredReasons: {
                children: [],
                reasons: [
                  { reason: "audio-capture" },
                  { reason: "unload-listener" },
                ],
                url: "https://app.test/intake",
              },
              type: "back_forward",
            } as unknown as PerformanceNavigationTiming,
          ]
        : originalEntries(type)) as typeof performance.getEntriesByType;
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        signals: { ignoredBfcacheReasons: ["audio-capture"] },
      });
      await beacon.flush();
      const events = signalsSent(sent, "bfcache_blocked");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags?.reasons).toBe("unload-listener");
      expect(events[0]?.extra?.bfcacheBlockers).toEqual([
        {
          depth: 0,
          location: "https://app.test/intake",
          reasons: ["unload-listener"],
        },
      ]);
    } finally {
      performance.getEntriesByType = originalEntries;
    }
  });

  test("reports a scroll jail when scrollable content never moves", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const scrolling = document.scrollingElement ?? document.documentElement;
    Object.defineProperty(scrolling, "scrollHeight", {
      configurable: true,
      value: 3000,
    });
    Object.defineProperty(scrolling, "clientHeight", {
      configurable: true,
      value: VIEWPORT_H,
    });
    Object.defineProperty(scrolling, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    for (let index = 0; index < 8; index += 1) {
      const wheel = new Event("wheel", { bubbles: true });
      Object.defineProperty(wheel, "deltaY", { value: 100 });
      Object.defineProperty(wheel, "ctrlKey", { value: false });
      document.body.dispatchEvent(wheel);
    }
    await new Promise((resolve) => setTimeout(resolve, 550));
    await beacon.flush();
    expect(signalsSent(sent, "scroll_jail")).toHaveLength(1);
  });

  test("reports an immobile modal body when wheel input targets its header", async () => {
    const modal = document.createElement("section");
    modal.setAttribute("aria-modal", "true");
    const header = document.createElement("header");
    const body = document.createElement("div");
    body.style.overflowY = "auto";
    Object.defineProperty(body, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(body, "clientHeight", {
      configurable: true,
      value: 500,
    });
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    modal.append(header, body);
    document.body.append(modal);
    const { beacon, sent } = makeWatchdogBeacon();
    for (let index = 0; index < 8; index += 1) {
      const wheel = new Event("wheel", { bubbles: true });
      Object.defineProperty(wheel, "deltaY", { value: 100 });
      Object.defineProperty(wheel, "ctrlKey", { value: false });
      header.dispatchEvent(wheel);
    }
    await new Promise((resolve) => setTimeout(resolve, 550));
    await beacon.flush();
    expect(signalsSent(sent, "scroll_jail")).toHaveLength(1);
    modal.remove();
  });

  test("continues to ignore intentional page scroll lock beneath a modal", async () => {
    const modal = document.createElement("section");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    const { beacon, sent } = makeWatchdogBeacon();
    const scrolling = document.scrollingElement ?? document.documentElement;
    Object.defineProperty(scrolling, "scrollHeight", {
      configurable: true,
      value: 3000,
    });
    Object.defineProperty(scrolling, "clientHeight", {
      configurable: true,
      value: VIEWPORT_H,
    });
    Object.defineProperty(scrolling, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    for (let index = 0; index < 8; index += 1) {
      const wheel = new Event("wheel", { bubbles: true });
      Object.defineProperty(wheel, "deltaY", { value: 100 });
      Object.defineProperty(wheel, "ctrlKey", { value: false });
      document.body.dispatchEvent(wheel);
    }
    await new Promise((resolve) => setTimeout(resolve, 550));
    await beacon.flush();
    expect(signalsSent(sent, "scroll_jail")).toHaveLength(0);
    modal.remove();
  });

  test("does not report compositor-delayed wheel movement as a scroll jail", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const scrolling = document.scrollingElement ?? document.documentElement;
    Object.defineProperty(scrolling, "scrollHeight", {
      configurable: true,
      value: 3000,
    });
    Object.defineProperty(scrolling, "clientHeight", {
      configurable: true,
      value: VIEWPORT_H,
    });
    Object.defineProperty(scrolling, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    for (let index = 0; index < 8; index += 1) {
      const wheel = new Event("wheel", { bubbles: true });
      Object.defineProperty(wheel, "deltaY", { value: 100 });
      Object.defineProperty(wheel, "ctrlKey", { value: false });
      document.body.dispatchEvent(wheel);
    }
    // Browser default scrolling can become visible only after every passive
    // wheel listener in the burst has observed the old main-thread position.
    setTimeout(() => {
      scrolling.scrollTop = 100;
    }, 250);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await beacon.flush();
    expect(signalsSent(sent, "scroll_jail")).toHaveLength(0);
  });

  test("does not report a newly targeted pane while the latched pane scrolls", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const main = document.createElement("main");
    const sidebar = document.createElement("nav");
    main.style.overflowY = "auto";
    sidebar.style.overflowY = "auto";
    for (const element of [main, sidebar]) {
      Object.defineProperty(element, "scrollHeight", {
        configurable: true,
        value: 2000,
      });
      Object.defineProperty(element, "clientHeight", {
        configurable: true,
        value: 500,
      });
      Object.defineProperty(element, "scrollTop", {
        configurable: true,
        value: 0,
        writable: true,
      });
    }
    document.body.append(main, sidebar);
    for (let index = 0; index < 8; index += 1) {
      const wheel = new Event("wheel", { bubbles: true });
      Object.defineProperty(wheel, "deltaY", { value: 100 });
      Object.defineProperty(wheel, "ctrlKey", { value: false });
      sidebar.dispatchEvent(wheel);
      if (index === 3) {
        main.scrollTop = 400;
        main.dispatchEvent(new Event("scroll"));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 550));
    await beacon.flush();
    expect(signalsSent(sent, "scroll_jail")).toHaveLength(0);
    main.remove();
    sidebar.remove();
  });

  test("waits for wheel input to go quiet before reporting a scroll jail", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const scrolling = document.scrollingElement ?? document.documentElement;
    Object.defineProperty(scrolling, "scrollHeight", {
      configurable: true,
      value: 3000,
    });
    Object.defineProperty(scrolling, "clientHeight", {
      configurable: true,
      value: VIEWPORT_H,
    });
    Object.defineProperty(scrolling, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    const dispatchWheel = (): void => {
      const wheel = new Event("wheel", { bubbles: true });
      Object.defineProperty(wheel, "deltaY", { value: 100 });
      Object.defineProperty(wheel, "ctrlKey", { value: false });
      document.body.dispatchEvent(wheel);
    };
    for (let index = 0; index < 8; index += 1) dispatchWheel();
    await new Promise((resolve) => setTimeout(resolve, 300));
    dispatchWheel();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await beacon.flush();
    expect(signalsSent(sent, "scroll_jail")).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 300));
    await beacon.flush();
    expect(signalsSent(sent, "scroll_jail")).toHaveLength(1);
  });

  test("does not treat minor-axis pointer jitter as cursor thrashing", async () => {
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { thrashedCursorReversals: 3 },
    });
    for (const [x, y] of [
      [0, 100],
      [20, 102],
      [40, 98],
      [60, 102],
      [80, 98],
      [100, 102],
    ] as const) {
      movePointer(x, y);
    }
    await beacon.flush();
    expect(signalsSent(sent, "thrashed_cursor")).toHaveLength(0);
  });

  test("does not treat a smooth curved pointer path as cursor thrashing", async () => {
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { thrashedCursorReversals: 3 },
    });
    for (const [x, y] of [
      [0, 0],
      [20, 0],
      [34, 14],
      [34, 34],
      [20, 48],
      [0, 48],
      [-14, 34],
    ] as const) {
      movePointer(x, y);
    }
    await beacon.flush();
    expect(signalsSent(sent, "thrashed_cursor")).toHaveLength(0);
  });

  test("reports repeated substantial back-and-forth pointer reversals", async () => {
    const target = document.createElement("div");
    target.className = "busy-panel";
    document.body.append(target);
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { thrashedCursorReversals: 3 },
    });
    for (const x of [0, 40, 0, 40, 0]) {
      target.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: x,
          clientY: 100,
          pointerType: "mouse",
        }),
      );
    }
    await beacon.flush();
    const events = signalsSent(sent, "thrashed_cursor");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      reversals: "3",
      target: "div.busy-panel",
    });
    target.remove();
  });

  test("reports focus dropped to body when a dialog unmounts", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const closeButton = document.createElement("button");
    dialog.append(closeButton);
    document.body.append(dialog);
    closeButton.focus();
    dialog.remove();
    document.dispatchEvent(new Event("focusout"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await beacon.flush();
    expect(signalsSent(sent, "focus_lost")).toHaveLength(1);
  });

  test("reports a modal that never receives initial focus", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { beacon, sent } = makeWatchdogBeacon();
    const modal = document.createElement("section");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("role", "dialog");
    const close = document.createElement("button");
    modal.append(close);
    document.body.append(modal);
    await new Promise((resolve) => setTimeout(resolve, 130));
    await beacon.flush();
    const events = signalsSent(sent, "modal_focus_escape");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.reason).toBe("initial-focus-missing");
    modal.remove();
    opener.remove();
  });

  test("ignores a mounted hidden aria-modal", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const modal = document.createElement("section");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("role", "dialog");
    modal.style.display = "none";
    modal.append(document.createElement("button"));
    document.body.append(modal);
    const { beacon, sent } = makeWatchdogBeacon();
    await new Promise((resolve) => setTimeout(resolve, 130));
    await beacon.flush();
    expect(signalsSent(sent, "modal_focus_escape")).toHaveLength(0);
    modal.remove();
    opener.remove();
  });

  test("checks focus when a mounted hidden modal becomes visible", async () => {
    const modal = document.createElement("section");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("role", "dialog");
    modal.style.display = "none";
    modal.append(document.createElement("button"));
    document.body.append(modal);
    const { beacon, sent } = makeWatchdogBeacon();
    modal.style.display = "";
    await new Promise((resolve) => setTimeout(resolve, 130));
    await beacon.flush();
    expect(signalsSent(sent, "modal_focus_escape")).toHaveLength(1);
    modal.remove();
  });

  test("accepts focus when a mounted hidden modal becomes visible", async () => {
    const modal = document.createElement("section");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("role", "dialog");
    modal.style.display = "none";
    const close = document.createElement("button");
    modal.append(close);
    document.body.append(modal);
    const { beacon, sent } = makeWatchdogBeacon();
    modal.style.display = "";
    close.focus();
    await new Promise((resolve) => setTimeout(resolve, 130));
    await beacon.flush();
    expect(signalsSent(sent, "modal_focus_escape")).toHaveLength(0);
    modal.remove();
  });

  test("ignores trigger restoration while a modal is being removed", async () => {
    const outside = document.createElement("button");
    const modal = document.createElement("section");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("role", "dialog");
    const close = document.createElement("button");
    modal.append(close);
    document.body.append(outside, modal);
    const { beacon, sent } = makeWatchdogBeacon();
    close.focus();
    await new Promise((resolve) => setTimeout(resolve, 130));

    outside.focus();
    queueMicrotask(() => modal.remove());
    await new Promise((resolve) => setTimeout(resolve, 20));
    await beacon.flush();
    expect(signalsSent(sent, "modal_focus_escape")).toHaveLength(0);
    outside.remove();
  });

  test("reports focus that remains outside a still-open modal", async () => {
    const outside = document.createElement("button");
    const modal = document.createElement("section");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("role", "dialog");
    const close = document.createElement("button");
    modal.append(close);
    document.body.append(outside, modal);
    const { beacon, sent } = makeWatchdogBeacon();
    close.focus();
    await new Promise((resolve) => setTimeout(resolve, 130));

    outside.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await beacon.flush();
    const events = signalsSent(sent, "modal_focus_escape");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.reason).toBe("escaped");
    modal.remove();
    outside.remove();
  });

  test("reports enforced CSP violations without reporting report-only policy", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const reportOnly = new Event("securitypolicyviolation");
    Object.defineProperties(reportOnly, {
      blockedURI: { value: "https://cdn.test/report.js?token=secret" },
      disposition: { value: "report" },
      effectiveDirective: { value: "script-src-elem" },
      lineNumber: { value: 0 },
      sourceFile: { value: "" },
      violatedDirective: { value: "script-src" },
    });
    document.dispatchEvent(reportOnly);
    const enforced = new Event("securitypolicyviolation");
    Object.defineProperties(enforced, {
      blockedURI: { value: "https://cdn.test/app.js?token=secret" },
      disposition: { value: "enforce" },
      effectiveDirective: { value: "script-src-elem" },
      lineNumber: { value: 12 },
      sourceFile: { value: "https://app.test/index.js?secret=yes" },
      violatedDirective: { value: "script-src" },
    });
    document.dispatchEvent(enforced);
    await beacon.flush();
    const events = signalsSent(sent, "csp_violation");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      blockedUri: "https://cdn.test/app.js",
      directive: "script-src-elem",
      disposition: "enforce",
      sourceFile: "https://app.test/index.js",
      sourceLine: "12",
    });
  });

  test("reports browser interventions from ReportingObserver", async () => {
    const original = globalThis.ReportingObserver;
    class FakeReportingObserver {
      private readonly callback: ReportingObserverCallback;
      constructor(callback: ReportingObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(): void {
        this.callback(
          [
            {
              body: {
                id: "HeavyAdIntervention",
                lineNumber: 9,
                message: "An operation was blocked",
                sourceFile: "https://app.test/ad.js",
              },
              type: "intervention",
              url: "https://app.test/portal",
            } as unknown as Report,
          ],
          this as unknown as ReportingObserver,
        );
      }
      takeRecords(): ReportList {
        return [];
      }
    }
    globalThis.ReportingObserver =
      FakeReportingObserver as unknown as typeof ReportingObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      const events = signalsSent(sent, "browser_intervention");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags?.interventionId).toBe("HeavyAdIntervention");
    } finally {
      globalThis.ReportingObserver = original;
    }
  });

  test("reports repeated visible main-thread stalls", async () => {
    const original = globalThis.PerformanceObserver;
    let durations = [210, 240, 280];
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(): void {
        this.callback(
          {
            getEntries: () =>
              durations.map(
                (duration, index) =>
                  ({
                    blockingDuration: duration,
                    duration,
                    entryType: "long-animation-frame",
                    startTime: index * 1_000,
                  }) as unknown as PerformanceEntry,
              ),
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      const events = signalsSent(sent, "main_thread_stall");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags).toMatchObject({
        blockingDurationMs: "280",
        entryType: "long-animation-frame",
        framePhase: "startup",
        scriptAttribution: "unavailable",
        scriptCount: "0",
        scriptDurationMs: "0",
        stallCount: "3",
      });
      durations = [810, 820, 830];
      const second = makeWatchdogBeacon();
      await second.beacon.flush();
      const secondEvents = signalsSent(second.sent, "main_thread_stall");
      expect(secondEvents).toHaveLength(1);
      expect(secondEvents[0]?.tags?.blockingDurationMs).toBe("830");
      expect(secondEvents[0]?.groupingKey).toBe(events[0]?.groupingKey);
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("retains detailed long-animation-frame attribution", async () => {
    const original = globalThis.PerformanceObserver;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(): void {
        this.callback(
          {
            getEntries: () =>
              [210, 230, 480].map((blockingDuration, index) => ({
                blockingDuration,
                duration: index === 2 ? 540 : blockingDuration,
                entryType: "long-animation-frame",
                firstUIEventTimestamp: index === 2 ? 2_080 : 0,
                renderStart: index === 2 ? 2_400 : 0,
                scripts:
                  index === 2
                    ? [
                        {
                          duration: 260,
                          forcedStyleAndLayoutDuration: 34,
                          invoker: "BUTTON.onclick",
                          invokerType: "event-listener",
                          pauseDuration: 6,
                          sourceCharPosition: 842,
                          sourceFunctionName: "hydrateProfile",
                          sourceURL:
                            "https://app.example/assets/profile.js?token=secret",
                          windowAttribution: "self",
                        },
                        { duration: 80 },
                      ]
                    : [],
                startTime: index * 1_000,
                styleAndLayoutStart: index === 2 ? 2_470 : 0,
              })) as unknown as PerformanceEntry[],
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      expect(signalsSent(sent, "main_thread_stall")[0]?.tags).toMatchObject({
        firstUIEventAtMs: "2080",
        renderDurationMs: "140",
        scriptAttribution: "available",
        scriptCount: "2",
        scriptDurationMs: "340",
        scriptForcedStyleAndLayoutMs: "34",
        scriptFunction: "hydrateProfile",
        scriptInvoker: "BUTTON.onclick",
        scriptInvokerType: "event-listener",
        scriptPauseDurationMs: "6",
        scriptSource: "/assets/profile.js",
        scriptSourceCharPosition: "842",
        scriptWindowAttribution: "self",
        styleAndLayoutDurationMs: "70",
      });
      expect(
        signalsSent(sent, "main_thread_stall")[0]?.extra?.scriptTimings,
      ).toEqual([
        {
          durationMs: 260,
          forcedStyleAndLayoutDurationMs: 34,
          invoker: "BUTTON.onclick",
          invokerType: "event-listener",
          pauseDurationMs: 6,
          sourceCharPosition: 842,
          sourceFunctionName: "hydrateProfile",
          sourceURL: "/assets/profile.js",
          windowAttribution: "self",
        },
        { durationMs: 80 },
      ]);
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("ignores long animation frames with no blocking duration", async () => {
    const original = globalThis.PerformanceObserver;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(): void {
        this.callback(
          {
            getEntries: () =>
              [228, 450, 1002].map(
                (duration) =>
                  ({
                    blockingDuration: 0,
                    duration,
                    entryType: "long-animation-frame",
                  }) as unknown as PerformanceEntry,
              ),
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      expect(signalsSent(sent, "main_thread_stall")).toHaveLength(0);
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("does not collapse spaced buffered stalls into one burst", async () => {
    const original = globalThis.PerformanceObserver;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(): void {
        this.callback(
          {
            getEntries: () =>
              [
                { blockingDuration: 220, startTime: 1_000 },
                { blockingDuration: 230, startTime: 21_000 },
                { blockingDuration: 240, startTime: 41_000 },
              ].map(
                ({ blockingDuration, startTime }) =>
                  ({
                    blockingDuration,
                    duration: blockingDuration,
                    entryType: "long-animation-frame",
                    startTime,
                  }) as unknown as PerformanceEntry,
              ),
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      expect(signalsSent(sent, "main_thread_stall")).toHaveLength(0);
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("attributes slow interactions with Event Timing instead of click timers", async () => {
    const original = globalThis.PerformanceObserver;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type === "long-animation-frame") {
          this.callback(
            {
              getEntries: () => [
                {
                  blockingDuration: 240,
                  duration: 400,
                  entryType: "long-animation-frame",
                  scripts: [
                    {
                      duration: 220,
                      functionName: "saveDeal",
                      invoker: "BUTTON.onclick",
                      sourceURL:
                        "https://app.example/assets/deal.js?token=secret",
                    },
                  ],
                  startTime: 90,
                } as unknown as PerformanceEntry,
              ],
            } as PerformanceObserverEntryList,
            this as unknown as PerformanceObserver,
          );
          return;
        }
        if (options.type !== "event") return;
        const button = document.createElement("button");
        button.setAttribute(BEACON_ATTRIBUTE.NAME, "save-deal");
        this.callback(
          {
            getEntries: () =>
              [
                {
                  duration: 1240,
                  interactionId: 41,
                  processingEnd: 300,
                  processingStart: 180,
                  startTime: 100,
                },
                {
                  duration: 1310,
                  interactionId: 42,
                  processingEnd: 340,
                  processingStart: 210,
                  startTime: 110,
                },
              ].map((entry) => ({
                ...entry,
                entryType: "event",
                name: "click",
                target: button,
              })) as unknown as PerformanceEntry[],
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        signals: { slowInteractionMs: 1000 },
      });
      await beacon.flush();
      const events = signalsSent(sent, "slow_interaction");
      expect(events).toHaveLength(2);
      expect(events[0]?.message).toContain("click took 1240ms");
      expect(events[0]?.tags).toMatchObject({
        blockingDurationMs: "240",
        blockingEntryType: "long-animation-frame",
        blockingFrameDurationMs: "400",
        durationMs: "1240",
        eventType: "click",
        inputDelayMs: "80",
        interactionId: "41",
        presentationDelayMs: "1040",
        processingDurationMs: "120",
        scriptFunction: "saveDeal",
        scriptInvoker: "BUTTON.onclick",
        scriptSource: "/assets/deal.js",
        target: "button[save-deal]",
      });
      expect(events[1]?.groupingKey).toBe(events[0]?.groupingKey);
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("ignores Event Timing entries without a real interaction id", async () => {
    const original = globalThis.PerformanceObserver;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type !== "event") return;
        this.callback(
          {
            getEntries: () => [
              {
                duration: 120_904,
                entryType: "event",
                interactionId: 0,
                name: "pointerout",
                target: document.body,
              } as unknown as PerformanceEntry,
            ],
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        signals: { slowInteractionMs: 1000 },
      });
      await beacon.flush();
      expect(signalsSent(sent, "slow_interaction")).toHaveLength(0);
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("ignores input-delay-only browser scheduling artifacts", async () => {
    const original = globalThis.PerformanceObserver;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type !== "event") return;
        this.callback(
          {
            getEntries: () => [
              {
                duration: 17_752,
                entryType: "event",
                interactionId: 4101,
                name: "keyup",
                processingEnd: 17_807,
                processingStart: 17_807,
                startTime: 100,
                target: document.createElement("input"),
              } as unknown as PerformanceEntry,
            ],
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        signals: { slowInteractionMs: 1000 },
      });
      await beacon.flush();
      expect(signalsSent(sent, "slow_interaction")).toHaveLength(0);
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("drops presentation-only slow interactions with or without a target", async () => {
    const original = globalThis.PerformanceObserver;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type === "long-animation-frame") {
          this.callback(
            {
              getEntries: () => [
                {
                  blockingDuration: 240,
                  duration: 400,
                  entryType: "long-animation-frame",
                  startTime: 2000,
                } as unknown as PerformanceEntry,
              ],
            } as PerformanceObserverEntryList,
            this as unknown as PerformanceObserver,
          );
          return;
        }
        if (options.type !== "event") return;
        const button = document.createElement("button");
        this.callback(
          {
            getEntries: () => [
              {
                duration: 1208,
                entryType: "event",
                interactionId: 5480,
                name: "pointerdown",
                processingEnd: 108,
                processingStart: 108,
                startTime: 100,
                target: button,
              } as unknown as PerformanceEntry,
              {
                duration: 1200,
                entryType: "event",
                interactionId: 5481,
                name: "pointerup",
                processingEnd: 2008,
                processingStart: 2008,
                startTime: 2000,
                target: null,
              } as unknown as PerformanceEntry,
            ],
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        signals: { slowInteractionMs: 1000 },
      });
      await beacon.flush();
      const events = signalsSent(sent, "slow_interaction");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags).toMatchObject({
        blockingDurationMs: "240",
        interactionId: "5481",
        target: "unknown",
      });
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("attributes disruptive layout shifts to their source elements", async () => {
    const original = globalThis.PerformanceObserver;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type !== "layout-shift") return;
        const banner = document.createElement("div");
        banner.className = "late-banner";
        this.callback(
          {
            getEntries: () => [
              {
                duration: 0,
                entryType: "layout-shift",
                hadRecentInput: false,
                sources: [{ node: banner }],
                value: 0.18,
              } as unknown as PerformanceEntry,
            ],
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      const events = signalsSent(sent, "disruptive_layout_shift");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags?.target).toBe("div.late-banner");
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("suppresses a click-adjacent layout shift when the browser misses recent input", async () => {
    const original = globalThis.PerformanceObserver;
    let callback: PerformanceObserverCallback | undefined;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(next: PerformanceObserverCallback) {
        this.callback = next;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type === "layout-shift") callback = this.callback;
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const button = document.createElement("button");
      document.body.append(button);
      const { beacon, sent } = makeWatchdogBeacon({
        instrument: { ...ALL_OFF, clicks: true },
      });
      button.click();
      const shifted = document.createElement("div");
      shifted.className = "pause-panel";
      const activeCallback = callback;
      const observer = new FakePerformanceObserver(() => undefined);
      activeCallback?.(
        {
          getEntries: () => [
            {
              duration: 0,
              entryType: "layout-shift",
              hadRecentInput: false,
              sources: [{ node: shifted }],
              startTime: performance.now(),
              value: 0.18,
            } as unknown as PerformanceEntry,
          ],
        } as PerformanceObserverEntryList,
        observer as unknown as PerformanceObserver,
      );
      await beacon.flush();
      expect(signalsSent(sent, "disruptive_layout_shift")).toHaveLength(0);
      button.remove();
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("reports a layout shift outside Beacon's recent-input fallback window", async () => {
    const original = globalThis.PerformanceObserver;
    let callback: PerformanceObserverCallback | undefined;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(next: PerformanceObserverCallback) {
        this.callback = next;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type === "layout-shift") callback = this.callback;
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const button = document.createElement("button");
      document.body.append(button);
      const { beacon, sent } = makeWatchdogBeacon({
        instrument: { ...ALL_OFF, clicks: true },
      });
      button.click();
      const shifted = document.createElement("div");
      shifted.className = "late-panel";
      const activeCallback = callback;
      const observer = new FakePerformanceObserver(() => undefined);
      activeCallback?.(
        {
          getEntries: () => [
            {
              duration: 0,
              entryType: "layout-shift",
              hadRecentInput: false,
              sources: [{ node: shifted }],
              startTime: performance.now() + 501,
              value: 0.18,
            } as unknown as PerformanceEntry,
          ],
        } as PerformanceObserverEntryList,
        observer as unknown as PerformanceObserver,
      );
      await beacon.flush();
      expect(signalsSent(sent, "disruptive_layout_shift")).toHaveLength(1);
      button.remove();
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("groups unknown layout shifts by stable lifecycle and interaction provenance", async () => {
    const original = globalThis.PerformanceObserver;
    let callback: PerformanceObserverCallback | undefined;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(next: PerformanceObserverCallback) {
        this.callback = next;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type === "layout-shift") callback = this.callback;
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    const report = async (targetClass: string, ageMs: number) => {
      const button = document.createElement("button");
      button.className = targetClass;
      document.body.append(button);
      const { beacon, sent } = makeWatchdogBeacon({
        instrument: { ...ALL_OFF, clicks: true },
      });
      button.click();
      callback?.(
        {
          getEntries: () => [
            {
              duration: 0,
              entryType: "layout-shift",
              hadRecentInput: false,
              sources: [],
              startTime: performance.now() + ageMs,
              value: 0.18,
            } as unknown as PerformanceEntry,
          ],
        } as PerformanceObserverEntryList,
        new FakePerformanceObserver(
          () => undefined,
        ) as unknown as PerformanceObserver,
      );
      await beacon.flush();
      const event = signalsSent(sent, "disruptive_layout_shift")[0];
      await beacon.close();
      button.remove();

      return event;
    };
    try {
      const first = await report("wallet-trigger", 650);
      const laterSameCause = await report("wallet-trigger", 900);
      const differentCause = await report("coupon-trigger", 650);

      expect(first?.tags).toMatchObject({
        interactionTarget: "button.wallet-trigger",
        interactionType: "click",
        target: "unknown",
      });
      expect(Number(first?.tags?.interactionAgeMs)).toBeGreaterThanOrEqual(650);
      expect(first?.tags?.framePhase).toBeDefined();
      expect(laterSameCause?.groupingKey).toBe(first?.groupingKey);
      expect(differentCause?.groupingKey).not.toBe(first?.groupingKey);
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("suppresses only layout shifts while a mobile keyboard viewport is active", async () => {
    const originalObserver = globalThis.PerformanceObserver;
    const originalViewport = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const originalInnerHeight = Object.getOwnPropertyDescriptor(
      window,
      "innerHeight",
    );
    let callback: PerformanceObserverCallback | undefined;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(next: PerformanceObserverCallback) {
        this.callback = next;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type === "layout-shift") callback = this.callback;
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    const viewport = Object.assign(new EventTarget(), {
      height: 500,
      offsetLeft: 0,
      offsetTop: 0,
      width: 390,
    });
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      const observer = new FakePerformanceObserver(() => undefined);
      const emitShift = (target: Element): void => {
        callback?.(
          {
            getEntries: () => [
              {
                duration: 0,
                entryType: "layout-shift",
                hadRecentInput: false,
                sources: [{ node: target }],
                startTime: performance.now() + 4_000,
                value: 0.24,
              } as unknown as PerformanceEntry,
            ],
          } as PerformanceObserverEntryList,
          observer as unknown as PerformanceObserver,
        );
      };

      const keyboardShift = document.createElement("div");
      keyboardShift.className = "keyboard-settling-content";
      emitShift(keyboardShift);
      await beacon.flush();
      expect(signalsSent(sent, "disruptive_layout_shift")).toHaveLength(0);

      viewport.height = 800;
      const genuineShift = document.createElement("div");
      genuineShift.className = "late-content";
      emitShift(genuineShift);
      await beacon.flush();
      const events = signalsSent(sent, "disruptive_layout_shift");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags?.target).toBe("div.late-content");
    } finally {
      textarea.remove();
      globalThis.PerformanceObserver = originalObserver;
      if (originalViewport === undefined) {
        Reflect.deleteProperty(window, "visualViewport");
      } else {
        Object.defineProperty(window, "visualViewport", originalViewport);
      }
      if (originalInnerHeight === undefined) {
        Reflect.deleteProperty(window, "innerHeight");
      } else {
        Object.defineProperty(window, "innerHeight", originalInnerHeight);
      }
    }
  });

  test("uses layout entry time to suppress only resize-adjacent shifts", async () => {
    const original = globalThis.PerformanceObserver;
    let callback: PerformanceObserverCallback | undefined;
    class FakePerformanceObserver {
      private readonly callback: PerformanceObserverCallback;
      constructor(next: PerformanceObserverCallback) {
        this.callback = next;
      }
      disconnect(): void {}
      observe(options: PerformanceObserverInit): void {
        if (options.type === "layout-shift") callback = this.callback;
      }
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    globalThis.PerformanceObserver =
      FakePerformanceObserver as unknown as typeof PerformanceObserver;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      window.dispatchEvent(new Event("resize"));
      const resizedAt = performance.now();
      const observer = new FakePerformanceObserver(() => undefined);
      const emitShift = (target: Element, startTime: number): void => {
        callback?.(
          {
            getEntries: () => [
              {
                duration: 0,
                entryType: "layout-shift",
                hadRecentInput: false,
                sources: [{ node: target }],
                startTime,
                value: 0.12,
              } as unknown as PerformanceEntry,
            ],
          } as PerformanceObserverEntryList,
          observer as unknown as PerformanceObserver,
        );
      };

      const responsiveReflow = document.createElement("aside");
      responsiveReflow.className = "responsive-sidebar";
      emitShift(responsiveReflow, resizedAt);
      await beacon.flush();
      expect(signalsSent(sent, "disruptive_layout_shift")).toHaveLength(0);

      const delayedShift = document.createElement("div");
      delayedShift.className = "late-content";
      emitShift(delayedShift, resizedAt + 501);
      await beacon.flush();
      const events = signalsSent(sent, "disruptive_layout_shift");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags?.target).toBe("div.late-content");
    } finally {
      globalThis.PerformanceObserver = original;
    }
  });

  test("reports a marked application root that settles blank", async () => {
    const root = document.createElement("main");
    root.setAttribute(BEACON_ATTRIBUTE.APP_ROOT, "portal");
    setRect(root, rectOf(0, 800, 0, 600));
    document.body.append(root);
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { blankAppRootSettleMs: 0 },
    });
    await tick();
    await beacon.flush();
    expect(signalsSent(sent, "blank_app_root")).toHaveLength(1);
    root.remove();
  });

  test("reports a marked dirty form abandoned on SPA navigation", async () => {
    const form = document.createElement("form");
    form.setAttribute(BEACON_ATTRIBUTE.FORM, "deal-editor");
    const input = document.createElement("input");
    form.append(input);
    document.body.append(form);
    const { beacon, sent } = makeWatchdogBeacon({
      instrument: { ...ALL_OFF, history: true },
    });
    const departedPath = `${location.pathname}${location.search}`;
    const destination =
      departedPath === "/after-form" ? "/after-form-next" : "/after-form";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    history.pushState(null, "", destination);
    await beacon.flush();
    const events = signalsSent(sent, "form_abandonment");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      fieldCount: "1",
      target: "deal-editor",
      url: departedPath === "blank" ? "/blank" : departedPath,
    });
    form.remove();
  });

  test("does not abandon a dirty form for same-URL history replacement", async () => {
    const form = document.createElement("form");
    form.setAttribute(BEACON_ATTRIBUTE.FORM, "invite-member");
    const input = document.createElement("input");
    form.append(input);
    document.body.append(form);
    const { beacon, sent } = makeWatchdogBeacon({
      instrument: { ...ALL_OFF, history: true },
    });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    history.replaceState(null, "", location.href);
    await beacon.flush();
    expect(signalsSent(sent, "form_abandonment")).toHaveLength(0);
    form.remove();
  });

  test("preserves a dirty form across a persisted BFCache pagehide", async () => {
    const form = document.createElement("form");
    form.setAttribute(BEACON_ATTRIBUTE.FORM, "invite-member");
    const input = document.createElement("input");
    form.append(input);
    document.body.append(form);
    const { beacon, sent } = makeWatchdogBeacon();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const cachedPageHide = new Event("pagehide");
    Object.defineProperty(cachedPageHide, "persisted", { value: true });
    window.dispatchEvent(cachedPageHide);
    await beacon.flush();
    expect(signalsSent(sent, "form_abandonment")).toHaveLength(0);

    const cachedPageShow = new Event("pageshow");
    Object.defineProperty(cachedPageShow, "persisted", { value: true });
    window.dispatchEvent(cachedPageShow);
    form.dispatchEvent(new Event("submit", { bubbles: true }));
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: false }),
    );
    await beacon.flush();
    expect(signalsSent(sent, "form_abandonment")).toHaveLength(0);
    form.remove();
  });

  test("reports a BFCache-restored dirty form on a later terminal pagehide", async () => {
    const form = document.createElement("form");
    form.setAttribute(BEACON_ATTRIBUTE.FORM, "invite-member");
    const input = document.createElement("input");
    form.append(input);
    document.body.append(form);
    const { beacon, sent } = makeWatchdogBeacon();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const cachedPageHide = new Event("pagehide");
    Object.defineProperty(cachedPageHide, "persisted", { value: true });
    window.dispatchEvent(cachedPageHide);
    const cachedPageShow = new Event("pageshow");
    Object.defineProperty(cachedPageShow, "persisted", { value: true });
    window.dispatchEvent(cachedPageShow);
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: false }),
    );
    await beacon.flush();
    expect(signalsSent(sent, "form_abandonment")).toHaveLength(1);
    form.remove();
  });

  test("reports marked media playback failures without inspecting media", async () => {
    const media = document.createElement("video");
    media.setAttribute(BEACON_ATTRIBUTE.MEDIA, "deal-preview");
    document.body.append(media);
    const { beacon, sent } = makeWatchdogBeacon();
    media.dispatchEvent(new Event("error"));
    await beacon.flush();
    const events = signalsSent(sent, "media_playback_failed");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.target).toBe("deal-preview");
    media.remove();
  });

  test("observeCapability reports handled browser API failures and rethrows", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const failure = new DOMException("permission denied", "NotAllowedError");
    await expect(
      beacon.observeCapability(
        "notifications.requestPermission",
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    await beacon.flush();
    const events = signalsSent(sent, "capability_failure");
    expect(events).toHaveLength(1);
    expect(events[0]?.groupingKey).toBe(
      "browser-capability:notifications.requestPermission",
    );
  });

  test("reports identical resubmits as form frustration", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const form = document.createElement("form");
    const field = document.createElement("input");
    field.name = "email";
    field.value = "same@value.test";
    form.append(field);
    document.body.append(form);
    for (let index = 0; index < 3; index += 1) {
      form.dispatchEvent(new Event("submit", { bubbles: true }));
    }
    await beacon.flush();
    expect(signalsSent(sent, "form_frustration")).toHaveLength(1);
    form.remove();
  });

  test("reports an open but silent EventSource as stalled", async () => {
    class FakeEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = 1;
      url: string;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
      }
      close(): void {
        this.readyState = 2;
      }
    }
    const original = window.EventSource;
    window.EventSource = FakeEventSource as unknown as typeof EventSource;
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, stalledStreamMs: 40 },
    });
    const source = new window.EventSource("https://app.test/stream/updates");
    await new Promise((resolve) => setTimeout(resolve, 90));
    await beacon.flush();
    const events = signalsSent(sent, "stalled_stream");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.endpoint).toBe("/stream/updates");
    source.close();
    await beacon.close();
    window.EventSource = original;
  });

  test("reports repeated EventSource reconnect failures as flapping", async () => {
    class FakeEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = 0;
      url: string;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
      }
      close(): void {
        this.readyState = 2;
      }
    }
    const original = window.EventSource;
    window.EventSource = FakeEventSource as unknown as typeof EventSource;
    const { beacon, sent } = makeWatchdogBeacon({
      signals: {
        layoutOverflowSettleMs: 0,
        sseFlapCount: 3,
        stalledStreams: false,
      },
    });
    const source = new window.EventSource("https://app.test/stream/updates");
    source.dispatchEvent(new Event("error"));
    source.dispatchEvent(new Event("error"));
    source.dispatchEvent(new Event("error"));
    await beacon.flush();
    const events = signalsSent(sent, "sse_flapping");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.errorCount).toBe("3");
    source.close();
    await beacon.close();
    window.EventSource = original;
  });

  test("reports websocket connect/close churn as flapping", async () => {
    class FakeWebSocket extends EventTarget {
      url: string;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
      }
      close(): void {}
      serverClose(): void {
        this.dispatchEvent(
          new CloseEvent("close", { code: 1006, wasClean: false }),
        );
      }
    }
    const original = window.WebSocket;
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { beacon, sent } = makeWatchdogBeacon({
      signals: {
        layoutOverflowSettleMs: 0,
        recoverableSockets: ["/sync/ws"],
      },
    });
    for (let index = 0; index < 4; index += 1) {
      const socket = new window.WebSocket("wss://app.test/sync/ws");
      (socket as unknown as FakeWebSocket).serverClose();
    }
    await beacon.flush();
    const events = signalsSent(sent, "socket_flapping");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.endpoint).toBe("/sync/ws");
    expect(signalsSent(sent, "socket_abnormal_close")).toHaveLength(0);
    await beacon.close();
    window.WebSocket = original;
  });

  test("does not count application-initiated WebSocket closes", async () => {
    class FakeWebSocket extends EventTarget {
      url: string;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
      }
      close(): void {
        this.dispatchEvent(
          new CloseEvent("close", { code: 1005, wasClean: true }),
        );
      }
    }
    const original = window.WebSocket;
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { beacon, sent } = makeWatchdogBeacon();
    for (let index = 0; index < 4; index += 1) {
      new window.WebSocket("wss://app.test/sync/ws").close();
    }
    await beacon.flush();
    expect(signalsSent(sent, "socket_flapping")).toHaveLength(0);
    expect(signalsSent(sent, "socket_abnormal_close")).toHaveLength(0);
    await beacon.close();
    window.WebSocket = original;
  });

  test("reports an abnormal WebSocket close with its close code", async () => {
    class FakeWebSocket extends EventTarget {
      url: string;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
      }
      close(): void {}
    }
    const original = window.WebSocket;
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, socketFlapping: false },
    });
    const normalSocket = new window.WebSocket("wss://app.test/sync/ws");
    normalSocket.dispatchEvent(
      new CloseEvent("close", { code: 1000, wasClean: true }),
    );
    const cleanNoStatusSocket = new window.WebSocket("wss://app.test/sync/ws");
    cleanNoStatusSocket.dispatchEvent(
      new CloseEvent("close", { code: 1005, wasClean: true }),
    );
    await beacon.flush();
    expect(sent).toHaveLength(0);
    const socket = new window.WebSocket("wss://app.test/sync/ws");
    socket.dispatchEvent(
      new CloseEvent("close", { code: 1006, wasClean: false }),
    );
    await beacon.flush();
    const events = signalsSent(sent, "socket_abnormal_close");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      closeCode: "1006",
      endpoint: "/sync/ws",
      wasClean: "false",
    });
    await beacon.close();
    window.WebSocket = original;
  });

  test("suppresses an isolated abnormal close for a recoverable socket", async () => {
    class FakeWebSocket extends EventTarget {
      url: string;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
      }
      close(): void {}
    }
    const original = window.WebSocket;
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { beacon, sent } = makeWatchdogBeacon({
      signals: {
        layoutOverflowSettleMs: 0,
        recoverableSockets: ["/sync/ws"],
        socketFlapping: false,
      },
    });
    const socket = new window.WebSocket("wss://app.test/sync/ws");
    socket.dispatchEvent(
      new CloseEvent("close", { code: 1006, wasClean: false }),
    );
    await beacon.flush();

    expect(signalsSent(sent, "socket_abnormal_close")).toHaveLength(0);
    await beacon.close();
    window.WebSocket = original;
  });

  test("attributes queued BFCache socket closes to the prior page lifecycle", async () => {
    class FakeWebSocket extends EventTarget {
      url: string;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
      }
      close(): void {}
      serverClose(): void {
        this.dispatchEvent(
          new CloseEvent("close", { code: 1006, wasClean: false }),
        );
      }
    }
    const original = window.WebSocket;
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        signals: { layoutOverflowSettleMs: 0, socketFlapping: false },
      });
      const queuedLifecycleSocket = new window.WebSocket(
        "wss://app.test/sync/ws",
      );
      const genuinelyLaterSocket = new window.WebSocket(
        "wss://app.test/sync/ws",
      );
      window.dispatchEvent(new Event("pagehide"));
      const restored = new Event("pageshow");
      Object.defineProperty(restored, "persisted", { value: true });
      window.dispatchEvent(restored);

      (queuedLifecycleSocket as unknown as FakeWebSocket).serverClose();
      await beacon.flush();
      expect(signalsSent(sent, "socket_abnormal_close")).toHaveLength(0);

      now += 1001;
      (genuinelyLaterSocket as unknown as FakeWebSocket).serverClose();
      await beacon.flush();
      expect(signalsSent(sent, "socket_abnormal_close")).toHaveLength(1);
      await beacon.close();
    } finally {
      Date.now = originalNow;
      window.WebSocket = original;
    }
  });

  test("reports dedicated worker runtime failures", async () => {
    class FakeWorker extends EventTarget {
      constructor(_url: string | URL) {
        super();
      }
      postMessage(): void {}
      terminate(): void {}
    }
    const original = window.Worker;
    const fakeWorkerConstructor = FakeWorker as unknown as typeof Worker;
    window.Worker = fakeWorkerConstructor;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      const worker = new window.Worker("/workers/search.js");
      worker.dispatchEvent(
        new ErrorEvent("error", {
          filename: "https://app.test/workers/search.js",
          lineno: 14,
          message: "worker exploded",
        }),
      );
      await beacon.flush();
      const events = signalsSent(sent, "worker_failure");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags).toMatchObject({
        endpoint: "/workers/search.js",
        failureKind: "error",
        workerType: "dedicated",
      });
      await beacon.close();
      expect(window.Worker).toBe(fakeWorkerConstructor);
    } finally {
      window.Worker = original;
    }
  });

  test("reports shared-worker message decoding failures", async () => {
    class FakeMessagePort extends EventTarget {
      close(): void {}
      postMessage(): void {}
      start(): void {}
    }
    class FakeSharedWorker extends EventTarget {
      readonly port = new FakeMessagePort();
      constructor(_url: string | URL) {
        super();
      }
    }
    const original = window.SharedWorker;
    const fakeSharedWorkerConstructor =
      FakeSharedWorker as unknown as typeof SharedWorker;
    window.SharedWorker = fakeSharedWorkerConstructor;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      const worker = new window.SharedWorker("/workers/shared.js");
      worker.port.dispatchEvent(new MessageEvent("messageerror"));
      await beacon.flush();
      const events = signalsSent(sent, "worker_failure");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags).toMatchObject({
        endpoint: "/workers/shared.js",
        failureKind: "messageerror",
        workerType: "shared",
      });
      await beacon.close();
      expect(window.SharedWorker).toBe(fakeSharedWorkerConstructor);
    } finally {
      window.SharedWorker = original;
    }
  });

  test("reports handled service-worker registration failures", async () => {
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker",
    );
    const container = new EventTarget() as EventTarget & {
      register: ServiceWorkerContainer["register"];
    };
    container.register = async () => {
      throw new Error("registration rejected");
    };
    const originalRegister = container.register;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: container,
    });
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await navigator.serviceWorker.register("/sw.js").catch(() => undefined);
      await beacon.flush();
      const events = signalsSent(sent, "service_worker_failure");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags).toMatchObject({
        endpoint: "/sw.js",
        failureKind: "registration",
      });
      await beacon.close();
      expect(navigator.serviceWorker.register).toBe(originalRegister);
    } finally {
      if (serviceWorkerDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "serviceWorker");
      } else {
        Object.defineProperty(
          navigator,
          "serviceWorker",
          serviceWorkerDescriptor,
        );
      }
    }
  });

  test("suppresses an injected service-worker rejection through the wrapped register path", async () => {
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker",
    );
    const container = new EventTarget() as EventTarget & {
      register: ServiceWorkerContainer["register"];
    };
    container.register = async () => {
      const error = new Error("Rejected");
      error.stack =
        "Error: Rejected\n" +
        "    at ServiceWorkerContainer.<anonymous> (<anonymous>:669:449)\n" +
        "    at ServiceWorkerContainer.register (<anonymous>:460:195)";
      throw error;
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: container,
    });
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await navigator.serviceWorker.register("/sw.js").catch(() => undefined);
      await beacon.flush();
      expect(signalsSent(sent, "service_worker_failure")).toHaveLength(0);
      await beacon.close();
    } finally {
      if (serviceWorkerDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "serviceWorker");
      } else {
        Object.defineProperty(
          navigator,
          "serviceWorker",
          serviceWorkerDescriptor,
        );
      }
    }
  });

  test("suppresses a transient registration failure recovered by retry", async () => {
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker",
    );
    const registration = new EventTarget() as EventTarget & {
      installing: ServiceWorker | null;
    };
    registration.installing = null;
    let attempts = 0;
    const container = new EventTarget() as EventTarget & {
      register: ServiceWorkerContainer["register"];
    };
    container.register = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Script /sw.js load failed");
      return registration as ServiceWorkerRegistration;
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: container,
    });
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        signals: {
          layoutOverflowSettleMs: 0,
          serviceWorkerRecoveryMs: 10,
        },
      });
      await navigator.serviceWorker.register("/sw.js").catch(() => undefined);
      await navigator.serviceWorker.register("/sw.js");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await beacon.flush();
      expect(signalsSent(sent, "service_worker_failure")).toHaveLength(0);
      await beacon.close();
    } finally {
      if (serviceWorkerDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "serviceWorker");
      } else {
        Object.defineProperty(
          navigator,
          "serviceWorker",
          serviceWorkerDescriptor,
        );
      }
    }
  });

  test("reports a transient registration failure that does not recover", async () => {
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker",
    );
    const container = new EventTarget() as EventTarget & {
      register: ServiceWorkerContainer["register"];
    };
    container.register = async () => {
      throw new TypeError("Script /sw.js load failed");
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: container,
    });
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        signals: {
          layoutOverflowSettleMs: 0,
          serviceWorkerRecoveryMs: 5,
        },
      });
      await navigator.serviceWorker.register("/sw.js").catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await beacon.flush();
      const events = signalsSent(sent, "service_worker_failure");
      expect(events).toHaveLength(1);
      expect(events[0]?.extra?.serviceWorkerError).toMatchObject({
        message: "Script /sw.js load failed",
        name: "TypeError",
      });
      await beacon.close();
    } finally {
      if (serviceWorkerDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "serviceWorker");
      } else {
        Object.defineProperty(
          navigator,
          "serviceWorker",
          serviceWorkerDescriptor,
        );
      }
    }
  });

  test("tolerates a service-worker register shim with no registration", async () => {
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker",
    );
    const container = new EventTarget() as EventTarget & {
      register: ServiceWorkerContainer["register"];
    };
    container.register = async () => undefined as never;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: container,
    });
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await navigator.serviceWorker.register("/sw.js");
      await beacon.flush();
      expect(signalsSent(sent, "service_worker_failure")).toHaveLength(0);
      await beacon.close();
    } finally {
      if (serviceWorkerDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "serviceWorker");
      } else {
        Object.defineProperty(
          navigator,
          "serviceWorker",
          serviceWorkerDescriptor,
        );
      }
    }
  });

  test("reports a service worker that becomes redundant before activation", async () => {
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker",
    );
    class FakeServiceWorker extends EventTarget {
      readonly scriptURL = "https://app.test/sw.js";
      state: ServiceWorkerState = "installing";
    }
    const installing = new FakeServiceWorker();
    const registration = new EventTarget() as EventTarget & {
      installing: ServiceWorker | null;
    };
    registration.installing = installing as unknown as ServiceWorker;
    const container = new EventTarget() as EventTarget & {
      register: ServiceWorkerContainer["register"];
    };
    container.register = async () =>
      registration as unknown as ServiceWorkerRegistration;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: container,
    });
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await navigator.serviceWorker.register("/sw.js");
      installing.state = "redundant";
      installing.dispatchEvent(new Event("statechange"));
      await beacon.flush();
      const events = signalsSent(sent, "service_worker_failure");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags).toMatchObject({
        endpoint: "/sw.js",
        failureKind: "installation",
      });
      await beacon.close();
    } finally {
      if (serviceWorkerDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "serviceWorker");
      } else {
        Object.defineProperty(
          navigator,
          "serviceWorker",
          serviceWorkerDescriptor,
        );
      }
    }
  });

  test("reports one endpoint hammered inside the window as a storm", async () => {
    const originalFetch = window.fetch;
    window.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const { beacon, sent } = makeWatchdogBeacon({
      instrument: { ...ALL_OFF, fetch: true },
      signals: { layoutOverflowSettleMs: 0, requestStormCount: 5 },
    });
    await Promise.all(
      Array.from({ length: 5 }, () => window.fetch("/api/matches")),
    );
    await beacon.flush();
    const events = signalsSent(sent, "request_storm");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.endpoint).toBe("/api/matches");
    await beacon.close();
    window.fetch = originalFetch;
  });

  test("reports rapid repeated page loads as a reload loop", async () => {
    const now = Date.now();
    sessionStorage.setItem(
      "beacon:reload-history-v4",
      JSON.stringify([
        { at: now - 3000, route: location.pathname },
        { at: now - 2000, route: location.pathname },
        { at: now - 1000, route: location.pathname },
      ]),
    );
    const { beacon, sent } = makeWatchdogBeacon();
    await beacon.flush();
    const events = signalsSent(sent, "reload_loop");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      currentRelease: "unknown",
      entryKind: "app",
      loadCount: "4",
      serviceWorkerControlled: "false",
      serviceWorkerScript: "none",
      signal: "reload_loop",
      windowMs: expect.any(String),
    });
    sessionStorage.removeItem("beacon:reload-history-v4");
  });

  test("starts a new streak after an intentional same-route navigation", async () => {
    const now = Date.now();
    sessionStorage.setItem(
      "beacon:reload-history-v4",
      JSON.stringify([
        { at: now - 3000, route: location.pathname },
        { at: now - 2000, route: location.pathname },
        { at: now - 1000, route: location.pathname },
      ]),
    );
    sessionStorage.setItem("beacon:navigation-intent-v1", String(now));
    const { beacon, sent } = makeWatchdogBeacon();
    await beacon.flush();
    expect(signalsSent(sent, "reload_loop")).toHaveLength(0);
    expect(
      JSON.parse(sessionStorage.getItem("beacon:reload-history-v4") ?? "[]"),
    ).toEqual([{ at: expect.any(Number), route: location.pathname }]);
    expect(sessionStorage.getItem("beacon:navigation-intent-v1")).toBeNull();
  });

  test("records a submitted form only when the document leaves", async () => {
    const { beacon } = makeWatchdogBeacon();
    const form = document.createElement("form");
    document.body.append(form);
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(sessionStorage.getItem("beacon:navigation-intent-v1")).toBeNull();
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(
      Number(sessionStorage.getItem("beacon:navigation-intent-v1")),
    ).toBeGreaterThan(0);
    await beacon.close();
    form.remove();
  });

  test("does not join interleaved visits into a same-route reload loop", async () => {
    const now = Date.now();
    sessionStorage.setItem(
      "beacon:reload-history-v4",
      JSON.stringify([
        { at: now - 4000, route: location.pathname },
        { at: now - 3000, route: location.pathname },
        { at: now - 2000, route: "/admin/people" },
        { at: now - 1000, route: location.pathname },
      ]),
    );
    const { beacon, sent } = makeWatchdogBeacon();
    await beacon.flush();
    expect(signalsSent(sent, "reload_loop")).toHaveLength(0);
    sessionStorage.removeItem("beacon:reload-history-v4");
  });

  test("starts a new reload streak when authentication returns from another origin", async () => {
    const referrerDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "referrer",
    );
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "https://accounts.example.com/oauth/authorize",
    });
    const now = Date.now();
    sessionStorage.setItem(
      "beacon:reload-history-v4",
      JSON.stringify([
        { at: now - 3000, route: location.pathname },
        { at: now - 2000, route: location.pathname },
        { at: now - 1000, route: location.pathname },
      ]),
    );

    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      expect(signalsSent(sent, "reload_loop")).toHaveLength(0);
      expect(
        JSON.parse(sessionStorage.getItem("beacon:reload-history-v4") ?? "[]"),
      ).toEqual([{ at: expect.any(Number), route: location.pathname }]);
    } finally {
      Reflect.deleteProperty(document, "referrer");
      if (referrerDescriptor !== undefined) {
        Object.defineProperty(
          Document.prototype,
          "referrer",
          referrerDescriptor,
        );
      }
    }
  });

  test("starts a new reload streak after an accepted service worker update", async () => {
    const now = Date.now();
    sessionStorage.setItem(
      "beacon:service-worker-update-intent-v1",
      String(now),
    );

    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      expect(signalsSent(sent, "reload_loop")).toHaveLength(0);
      expect(
        JSON.parse(sessionStorage.getItem("beacon:reload-history-v4") ?? "[]"),
      ).toEqual([{ at: expect.any(Number), route: location.pathname }]);
      expect(
        sessionStorage.getItem("beacon:service-worker-update-intent-v1"),
      ).toBeNull();
    } finally {
      sessionStorage.removeItem("beacon:service-worker-update-intent-v1");
    }
  });

  test("does not mistake an ordinary same-origin reload for a service worker update", async () => {
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker",
    );
    const referrerDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "referrer",
    );
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: location.href,
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: () => undefined,
        controller: { scriptURL: `${location.origin}/sw.js` },
        removeEventListener: () => undefined,
      },
    });
    const now = Date.now();
    sessionStorage.setItem(
      "beacon:reload-history-v4",
      JSON.stringify([
        { at: now - 3000, route: location.pathname },
        { at: now - 2000, route: location.pathname },
        { at: now - 1000, route: location.pathname },
      ]),
    );

    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await beacon.flush();
      const events = signalsSent(sent, "reload_loop");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags).toMatchObject({
        entryKind: "app",
        serviceWorkerControlled: "true",
        serviceWorkerScript: `${location.origin}/sw.js`,
      });
    } finally {
      Reflect.deleteProperty(document, "referrer");
      if (referrerDescriptor !== undefined) {
        Object.defineProperty(
          Document.prototype,
          "referrer",
          referrerDescriptor,
        );
      }
      if (serviceWorkerDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "serviceWorker");
      } else {
        Object.defineProperty(
          navigator,
          "serviceWorker",
          serviceWorkerDescriptor,
        );
      }
    }
  });

  test("emits only once while the same reload streak continues", async () => {
    const now = Date.now();
    sessionStorage.setItem(
      "beacon:reload-history-v4",
      JSON.stringify([
        { at: now - 4000, route: location.pathname },
        { at: now - 3000, route: location.pathname },
        { at: now - 2000, route: location.pathname },
        { at: now - 1000, route: location.pathname },
      ]),
    );
    const { beacon, sent } = makeWatchdogBeacon();
    await beacon.flush();
    expect(signalsSent(sent, "reload_loop")).toHaveLength(0);
  });

  test("does not collapse different entity ids into one reload-loop route", async () => {
    const now = Date.now();
    sessionStorage.setItem(
      "beacon:reload-history-v4",
      JSON.stringify([
        {
          at: now - 3000,
          route: "/admin/support/11111111-1111-4111-8111-111111111111",
        },
        {
          at: now - 2000,
          route: "/admin/support/22222222-2222-4222-8222-222222222222",
        },
        {
          at: now - 1000,
          route: "/admin/support/33333333-3333-4333-8333-333333333333",
        },
      ]),
    );
    const { beacon, sent } = makeWatchdogBeacon();
    await beacon.flush();
    expect(signalsSent(sent, "reload_loop")).toHaveLength(0);
    const stored: unknown = JSON.parse(
      sessionStorage.getItem("beacon:reload-history-v4") ?? "[]",
    );
    expect(stored).toContainEqual({
      at: expect.any(Number),
      route: "/admin/support/11111111-1111-4111-8111-111111111111",
    });
    sessionStorage.removeItem("beacon:reload-history-v4");
  });

  test("reports running a build older than one already seen", async () => {
    const now = Date.now();
    localStorage.setItem(
      "beacon:release-first-seen",
      JSON.stringify({ v1: now - 1800000, v2: now - 1200000 }),
    );
    const { beacon, sent } = makeWatchdogBeacon({ release: "v1" });
    await beacon.flush();
    const events = signalsSent(sent, "stale_release");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.newestRelease).toBe("v2");
    localStorage.removeItem("beacon:release-first-seen");
  });

  test("probes the serving release and suppresses obsolete synthetic signals", async () => {
    const originalFetch = window.fetch;
    const stale: Array<{ currentRelease: string; newestRelease: string }> = [];
    window.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/version")) {
        return new Response(JSON.stringify({ commit: "v2" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      return new Response("failed", { status: 500 });
    }) as typeof window.fetch;
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        instrument: { ...ALL_OFF, fetch: true },
        release: "v1",
        releaseProbe: {
          endpoint: "https://app.test/version",
          onStale: (input) => stale.push(input),
        },
      });
      await tick();
      await tick();
      await window.fetch("/api/failing");
      await beacon.flush();

      const events = signalsSent(sent, "stale_release");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags).toMatchObject({
        currentRelease: "v1",
        newestRelease: "v2",
        staleDetection: "release-probe",
      });
      expect(signalsSent(sent, "server_error")).toHaveLength(0);
      expect(stale).toEqual([{ currentRelease: "v1", newestRelease: "v2" }]);
      await beacon.close();
    } finally {
      window.fetch = originalFetch;
    }
  });

  test("preserves and immediately sends a reload loop when the release probe reports stale", async () => {
    const originalFetch = window.fetch;
    const now = Date.now();
    sessionStorage.setItem(
      "beacon:reload-history-v4",
      JSON.stringify([
        { at: now - 3000, route: location.pathname },
        { at: now - 2000, route: location.pathname },
        { at: now - 1000, route: location.pathname },
      ]),
    );
    window.fetch = (async () =>
      new Response(JSON.stringify({ commit: "v2" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })) as unknown as typeof window.fetch;
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        beforeSend: (event) =>
          event.tags?.signal === "stale_release" ? null : event,
        release: "v1",
        releaseProbe: { endpoint: "https://app.test/version" },
      });
      await tick();
      await tick();

      const events = signalsSent(sent, "reload_loop");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags).toMatchObject({
        currentRelease: "v1",
        loadCount: "4",
        signal: "reload_loop",
      });
      expect(signalsSent(sent, "stale_release")).toHaveLength(0);
      await beacon.close();
    } finally {
      window.fetch = originalFetch;
    }
  });

  const installFailedFont = ({
    check = (_font: string) => false,
    display = "auto",
    family = "Material Icons",
    load = async () => [] as FontFace[],
    webdriver = false,
  }: {
    check?: (font: string) => boolean;
    display?: FontDisplay;
    family?: string;
    load?: () => Promise<FontFace[]>;
    webdriver?: boolean;
  } = {}) => {
    const original = Object.getOwnPropertyDescriptor(document, "fonts");
    const originalWebdriver = Object.getOwnPropertyDescriptor(
      navigator,
      "webdriver",
    );
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      value: webdriver,
    });
    let loadCalls = 0;
    const fakeFonts = {
      addEventListener: () => undefined,
      check,
      forEach: (callback: (face: FontFace) => void) => {
        callback({
          display,
          family,
          status: "error",
          stretch: "normal",
          style: "normal",
          weight: "400",
        } as FontFace);
      },
      load: async () => {
        loadCalls += 1;
        return load();
      },
      ready: Promise.resolve(),
      removeEventListener: () => undefined,
    };
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fakeFonts,
    });
    return {
      loadCalls: () => loadCalls,
      restore: () => {
        if (original === undefined) Reflect.deleteProperty(document, "fonts");
        else Object.defineProperty(document, "fonts", original);
        if (originalWebdriver === undefined) {
          Reflect.deleteProperty(navigator, "webdriver");
        } else {
          Object.defineProperty(navigator, "webdriver", originalWebdriver);
        }
      },
    };
  };

  const visibleMaterialIcon = (): HTMLElement => {
    const icon = document.createElement("span");
    icon.className = "material-icons font-failure-target";
    icon.style.fontFamily = '"Material Icons"';
    icon.textContent = "menu";
    setRect(icon, rectOf(0, 24, 0, 24));
    document.body.append(icon);
    return icon;
  };

  test("reports a failed font that is still missing on visible content", async () => {
    const font = installFailedFont();
    const icon = visibleMaterialIcon();
    const { beacon, sent } = makeWatchdogBeacon();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    const events = signalsSent(sent, "font_failure");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      fontFamily: "Material Icons",
      fontStyle: "normal",
      fontWeight: "400",
      target: "span.material-icons.font-failure-target",
    });
    await beacon.close();
    icon.remove();
    font.restore();
  });

  test("ignores a failed font face that no visible content uses", async () => {
    const font = installFailedFont();
    const { beacon, sent } = makeWatchdogBeacon();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    expect(signalsSent(sent, "font_failure")).toHaveLength(0);
    expect(font.loadCalls()).toBe(0);
    await beacon.close();
    font.restore();
  });

  test("ignores a failed font face that succeeds on explicit retry", async () => {
    const font = installFailedFont({ check: () => true });
    const icon = visibleMaterialIcon();
    const { beacon, sent } = makeWatchdogBeacon();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    expect(signalsSent(sent, "font_failure")).toHaveLength(0);
    expect(font.loadCalls()).toBe(1);
    await beacon.close();
    icon.remove();
    font.restore();
  });

  test("ignores an optional font face whose fallback is intentional", async () => {
    const font = installFailedFont({ display: "optional" });
    const icon = visibleMaterialIcon();
    const { beacon, sent } = makeWatchdogBeacon();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    expect(signalsSent(sent, "font_failure")).toHaveLength(0);
    expect(font.loadCalls()).toBe(0);
    await beacon.close();
    icon.remove();
    font.restore();
  });

  test("canonicalizes a quoted browser font family before retrying", async () => {
    let checkedFont = "";
    const font = installFailedFont({
      check: (value) => {
        checkedFont = value;
        return true;
      },
      family: '"Material Icons"',
    });
    const icon = visibleMaterialIcon();
    const { beacon, sent } = makeWatchdogBeacon();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    expect(signalsSent(sent, "font_failure")).toHaveLength(0);
    expect(checkedFont).toContain('16px "Material Icons"');
    expect(checkedFont).not.toContain('\\"Material Icons\\"');
    expect(font.loadCalls()).toBe(1);
    await beacon.close();
    icon.remove();
    font.restore();
  });

  test("does not diagnose fonts inside an automated browser", async () => {
    const font = installFailedFont({ webdriver: true });
    const icon = visibleMaterialIcon();
    const { beacon, sent } = makeWatchdogBeacon();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    expect(signalsSent(sent, "font_failure")).toHaveLength(0);
    expect(font.loadCalls()).toBe(0);
    await beacon.close();
    icon.remove();
    font.restore();
  });

  test("does not diagnose a short-lived scan that conceals webdriver", async () => {
    const font = installFailedFont({ webdriver: false });
    const icon = visibleMaterialIcon();
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { fontFailureConfirmMs: 100, layoutOverflowSettleMs: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    icon.remove();
    await new Promise((resolve) => setTimeout(resolve, 110));
    await beacon.flush();
    expect(signalsSent(sent, "font_failure")).toHaveLength(0);
    expect(font.loadCalls()).toBe(1);
    await beacon.close();
    font.restore();
  });

  test("confirms a persistent visible font failure with a second retry", async () => {
    const font = installFailedFont({ webdriver: false });
    const icon = visibleMaterialIcon();
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { fontFailureConfirmMs: 20, layoutOverflowSettleMs: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await beacon.flush();
    expect(signalsSent(sent, "font_failure")).toHaveLength(1);
    expect(font.loadCalls()).toBe(2);
    await beacon.close();
    icon.remove();
    font.restore();
  });

  test("reports a loading indicator that never resolves", async () => {
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, stuckLoadingMs: 40 },
    });
    const spinner = document.createElement("div");
    spinner.setAttribute("aria-busy", "true");
    setRect(spinner, rectOf(0, 40, 0, 40));
    document.body.append(spinner);
    await settle(beacon);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle(beacon);
    const events = signalsSent(sent, "stuck_loading");
    expect(events).toHaveLength(1);
    spinner.remove();
  });

  test("does not count a missed poll window as visible loading time", async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    const spinner = document.createElement("div");
    spinner.setAttribute("aria-busy", "true");
    setRect(spinner, rectOf(0, 40, 0, 40));
    document.body.append(spinner);
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        signals: { layoutOverflowSettleMs: 0, stuckLoadingMs: 40 },
      });
      await settle(beacon);
      now += 60_000;
      await settle(beacon);

      expect(signalsSent(sent, "stuck_loading")).toHaveLength(0);
    } finally {
      spinner.remove();
      Date.now = originalNow;
    }
  });

  test("starts a fresh deadline when a persistent control loads again", async () => {
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, stuckLoadingMs: 40 },
    });
    const button = document.createElement("button");
    button.setAttribute("aria-busy", "true");
    setRect(button, rectOf(0, 120, 0, 40));
    document.body.append(button);
    await settle(beacon);
    await new Promise((resolve) => setTimeout(resolve, 10));
    button.setAttribute("aria-busy", "false");
    await settle(beacon);
    await new Promise((resolve) => setTimeout(resolve, 50));
    button.setAttribute("aria-busy", "true");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle(beacon);
    try {
      expect(signalsSent(sent, "stuck_loading")).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await settle(beacon);
      expect(signalsSent(sent, "stuck_loading")).toHaveLength(1);
    } finally {
      button.remove();
    }
  });

  test("reports only the outer loading boundary for nested indicators", async () => {
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, stuckLoadingMs: 40 },
    });
    const boundary = document.createElement("div");
    boundary.setAttribute("aria-busy", "true");
    const spinner = document.createElement("div");
    spinner.setAttribute("aria-busy", "true");
    boundary.append(spinner);
    setRect(boundary, rectOf(0, 80, 0, 80));
    setRect(spinner, rectOf(20, 60, 20, 60));
    document.body.append(boundary);
    await settle(beacon);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle(beacon);
    const events = signalsSent(sent, "stuck_loading");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.target).toBe("div");
    boundary.remove();
  });

  test("ignores loading indicators hidden from the accessibility tree", async () => {
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, stuckLoadingMs: 40 },
    });
    const spinner = document.createElement("div");
    spinner.setAttribute("aria-busy", "true");
    spinner.setAttribute("aria-hidden", "true");
    setRect(spinner, rectOf(0, 40, 0, 40));
    document.body.append(spinner);
    await settle(beacon);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle(beacon);
    expect(signalsSent(sent, "stuck_loading")).toHaveLength(0);
    spinner.remove();
  });

  test("reports a control fully covered by an unrelated element", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const button = document.createElement("button");
    button.className = "buy-now";
    setRect(button, rectOf(100, 200, 100, 140));
    const scrim = document.createElement("div");
    scrim.className = "leaked-scrim";
    setRect(scrim, rectOf(0, VIEWPORT_W, 0, VIEWPORT_H));
    document.body.append(button, scrim);
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => scrim;
    await settle(beacon);
    const events = signalsSent(sent, "occluded_control");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.coveredBy).toBe("div.leaked-scrim");
    button.remove();
    scrim.remove();
    await beacon.close();
    document.elementFromPoint = originalFromPoint;
  });

  test("ignores page coverage across a non-modal dialog boundary", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const pageAction = document.createElement("button");
    pageAction.className = "invite-member";
    setRect(pageAction, rectOf(100, 300, 100, 144));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.className = "account-menu";
    setRect(dialog, rectOf(80, 320, 80, 300));
    document.body.append(pageAction, dialog);
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => dialog;
    await settle(beacon);
    expect(signalsSent(sent, "occluded_control")).toHaveLength(0);
    pageAction.remove();
    dialog.remove();
    await beacon.close();
    document.elementFromPoint = originalFromPoint;
  });

  test("still reports a control covered inside one dialog", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const action = document.createElement("button");
    action.className = "dialog-action";
    setRect(action, rectOf(100, 300, 100, 144));
    const leakedCover = document.createElement("div");
    leakedCover.className = "dialog-cover";
    setRect(leakedCover, rectOf(100, 300, 100, 144));
    dialog.append(action, leakedCover);
    document.body.append(dialog);
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => leakedCover;
    await settle(beacon);
    expect(signalsSent(sent, "occluded_control")).toHaveLength(1);
    dialog.remove();
    await beacon.close();
    document.elementFromPoint = originalFromPoint;
  });

  test("reports controls from separate layout groups that touch", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const primaryRow = document.createElement("div");
    const primary = document.createElement("button");
    primary.className = "generate-email";
    setRect(primary, rectOf(100, 700, 100, 146));
    primaryRow.append(primary);
    const channels = document.createElement("div");
    const linkedIn = document.createElement("a");
    linkedIn.className = "channel-cta";
    linkedIn.href = "https://linkedin.example/profile";
    setRect(linkedIn, rectOf(100, 320, 146, 184));
    channels.append(linkedIn);
    document.body.append(primaryRow, channels);

    await settle(beacon);
    const events = signalsSent(sent, "control_collision");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      collidesWith: "a.channel-cta",
      collisionAxis: "vertical",
      collisionKind: "touching",
      gapPx: "0",
      target: "button.generate-email",
    });
    primaryRow.remove();
    channels.remove();
  });

  test("reports controls whose border boxes overlap", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const firstWrap = document.createElement("div");
    const first = document.createElement("button");
    first.className = "primary-action";
    setRect(first, rectOf(100, 500, 100, 150));
    firstWrap.append(first);
    const secondWrap = document.createElement("div");
    const second = document.createElement("button");
    second.className = "secondary-action";
    setRect(second, rectOf(100, 300, 144, 184));
    secondWrap.append(second);
    document.body.append(firstWrap, secondWrap);

    await settle(beacon);
    const events = signalsSent(sent, "control_collision");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      collidesWith: "button.secondary-action",
      collisionAxis: "vertical",
      collisionKind: "overlap",
      overlapPx: "6",
      target: "button.primary-action",
    });
    firstWrap.remove();
    secondWrap.remove();
  });

  test("allows a positioned field action to overlap its padded input", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const field = document.createElement("div");
    const input = document.createElement("input");
    input.type = "password";
    setRect(input, rectOf(100, 500, 100, 144));
    const toggle = document.createElement("button");
    toggle.style.position = "absolute";
    setRect(toggle, rectOf(456, 500, 100, 144));
    field.append(input, toggle);
    document.body.append(field);

    await settle(beacon);
    expect(signalsSent(sent, "control_collision")).toHaveLength(0);
    field.remove();
  });

  test("ignores overlap between a dialog control and the covered page", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const pageAction = document.createElement("button");
    pageAction.className = "play-video";
    setRect(pageAction, rectOf(100, 500, 100, 300));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const privacyLink = document.createElement("a");
    privacyLink.className = "privacy-link";
    privacyLink.href = "/privacy-policy";
    setRect(privacyLink, rectOf(100, 300, 282, 322));
    dialog.append(privacyLink);
    document.body.append(pageAction, dialog);

    await settle(beacon);
    expect(signalsSent(sent, "control_collision")).toHaveLength(0);
    pageAction.remove();
    dialog.remove();
  });

  test("still reports overlapping controls inside one dialog", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const first = document.createElement("button");
    first.className = "dialog-primary";
    setRect(first, rectOf(100, 500, 100, 150));
    const second = document.createElement("button");
    second.className = "dialog-secondary";
    setRect(second, rectOf(100, 300, 144, 184));
    dialog.append(first, second);
    document.body.append(dialog);

    await settle(beacon);
    expect(signalsSent(sent, "control_collision")).toHaveLength(1);
    dialog.remove();
  });

  test("allows touching controls inside an intentional control group", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const toolbar = document.createElement("div");
    toolbar.setAttribute("role", "toolbar");
    const firstWrap = document.createElement("span");
    const first = document.createElement("button");
    setRect(first, rectOf(100, 200, 100, 140));
    firstWrap.append(first);
    const secondWrap = document.createElement("span");
    const second = document.createElement("button");
    setRect(second, rectOf(200, 300, 100, 140));
    secondWrap.append(second);
    toolbar.append(firstWrap, secondWrap);
    document.body.append(toolbar);

    await settle(beacon);
    expect(signalsSent(sent, "control_collision")).toHaveLength(0);
    toolbar.remove();
  });

  test("supports a Beacon control group without suppressing true overlaps", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const playlist = document.createElement("ol");
    playlist.setAttribute(BEACON_ATTRIBUTE.CONTROL_GROUP, "");
    const firstItem = document.createElement("li");
    const first = document.createElement("button");
    first.className = "playlist-item";
    setRect(first, rectOf(100, 500, 100, 150));
    firstItem.append(first);
    const secondItem = document.createElement("li");
    const second = document.createElement("button");
    second.className = "playlist-item";
    setRect(second, rectOf(100, 500, 151, 201));
    secondItem.append(second);
    playlist.append(firstItem, secondItem);
    document.body.append(playlist);

    await settle(beacon);
    expect(signalsSent(sent, "control_collision")).toHaveLength(0);

    setRect(second, rectOf(100, 500, 144, 194));
    window.dispatchEvent(new Event("resize"));
    await settle(beacon);
    const events = signalsSent(sent, "control_collision");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      collidesWith: "button.playlist-item",
      collisionKind: "overlap",
      overlapPx: "6",
      target: "button.playlist-item",
    });
    playlist.remove();
  });

  test("does not report a control covered by browser-extension UI", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const button = document.createElement("button");
    button.className = "consent-action";
    setRect(button, rectOf(100, 240, 100, 144));
    const extensionFrame = document.createElement("iframe");
    extensionFrame.id = "extension-toolbar";
    const originalGetAttribute =
      extensionFrame.getAttribute.bind(extensionFrame);
    extensionFrame.getAttribute = (name: string) =>
      name === "src"
        ? "chrome-extension://abc123/panel.html"
        : originalGetAttribute(name);
    setRect(extensionFrame, rectOf(80, 260, 80, 180));
    document.body.append(button, extensionFrame);
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => extensionFrame;
    await settle(beacon);
    expect(signalsSent(sent, "occluded_control")).toHaveLength(0);
    button.remove();
    extensionFrame.remove();
    await beacon.close();
    document.elementFromPoint = originalFromPoint;
  });

  test("does not report a control clipped below a scrolling ancestor", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const scroller = document.createElement("main");
    scroller.style.overflowY = "auto";
    setRect(scroller, rectOf(0, 390, 0, 220));
    const input = document.createElement("input");
    setRect(input, rectOf(12, 378, 250, 290));
    scroller.append(input);
    const normalFlowSibling = document.createElement("div");
    normalFlowSibling.className = "consent-copy";
    setRect(normalFlowSibling, rectOf(0, 390, 220, 420));
    document.body.append(scroller, normalFlowSibling);
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => normalFlowSibling;
    await settle(beacon);
    expect(signalsSent(sent, "occluded_control")).toHaveLength(0);
    scroller.remove();
    normalFlowSibling.remove();
    await beacon.close();
    document.elementFromPoint = originalFromPoint;
  });

  test("reports a genuinely covered visible portion of a clipped control", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const scroller = document.createElement("main");
    scroller.style.overflowY = "auto";
    setRect(scroller, rectOf(0, 390, 0, 160));
    const button = document.createElement("button");
    button.className = "partly-visible";
    setRect(button, rectOf(12, 180, 130, 170));
    scroller.append(button);
    const cover = document.createElement("div");
    cover.className = "real-cover";
    setRect(cover, rectOf(12, 180, 130, 160));
    document.body.append(scroller, cover);
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => cover;
    await settle(beacon);
    const events = signalsSent(sent, "occluded_control");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.coveredBy).toBe("div.real-cover");
    scroller.remove();
    cover.remove();
    await beacon.close();
    document.elementFromPoint = originalFromPoint;
  });

  test.each([
    ["aria-hidden", "true"],
    ["inert", ""],
  ])("does not scan controls under a %s ancestor", async (attribute, value) => {
    const { beacon, sent } = makeWatchdogBeacon();
    const hiddenDialog = document.createElement("div");
    hiddenDialog.setAttribute(attribute, value);
    hiddenDialog.style.opacity = "0";
    hiddenDialog.style.pointerEvents = "none";
    const button = document.createElement("button");
    setRect(button, rectOf(100, 200, 100, 140));
    hiddenDialog.append(button);
    const cover = document.createElement("div");
    setRect(cover, rectOf(0, VIEWPORT_W, 0, VIEWPORT_H));
    document.body.append(hiddenDialog, cover);
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => cover;
    await settle(beacon);
    expect(signalsSent(sent, "occluded_control")).toHaveLength(0);
    hiddenDialog.remove();
    cover.remove();
    await beacon.close();
    document.elementFromPoint = originalFromPoint;
  });

  test("does not scan controls inside closed details", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Filters";
    const input = document.createElement("input");
    setRect(input, rectOf(100, 300, 100, 144));
    details.append(summary, input);
    const loading = document.createElement("p");
    loading.className = "loading-state";
    setRect(loading, rectOf(100, 300, 100, 144));
    document.body.append(details, loading);
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => loading;
    await settle(beacon);
    expect(signalsSent(sent, "occluded_control")).toHaveLength(0);
    details.remove();
    loading.remove();
    await beacon.close();
    document.elementFromPoint = originalFromPoint;
  });

  test("reports text rendered the same color as its background", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    document.body.style.backgroundColor = "rgb(20, 20, 20)";
    const heading = document.createElement("h1");
    heading.textContent = "Invisible headline";
    heading.style.color = "rgb(20, 20, 20)";
    setRect(heading, rectOf(0, 400, 0, 40));
    document.body.append(heading);
    await settle(beacon);
    const events = signalsSent(sent, "invisible_text");
    expect(events).toHaveLength(1);
    heading.remove();
    document.body.style.backgroundColor = "";
  });

  test("reports nearly invisible semantic list text", async () => {
    const { beacon, sent } = makeWatchdogBeacon();
    document.body.style.backgroundColor = "rgb(20, 31, 48)";
    const list = document.createElement("ul");
    const item = document.createElement("li");
    item.className = "invitation-benefit";
    item.style.color = "rgb(30, 41, 59)";
    const description = document.createElement("span");
    description.textContent = "AI-sourced partnership matches";
    item.append(description);
    list.append(item);
    setRect(item, rectOf(0, 320, 0, 42));
    document.body.append(list);
    await settle(beacon);
    const events = signalsSent(sent, "invisible_text");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      contrast: "1.13",
      target: "li.invitation-benefit",
    });
    list.remove();
    document.body.style.backgroundColor = "";
    await beacon.close();
  });

  test("parses Tailwind oklch backgrounds instead of using a white ancestor", async () => {
    const button = document.createElement("button");
    button.textContent = "Resolve";
    button.style.color = "rgb(255, 255, 255)";
    setRect(button, rectOf(0, 120, 0, 40));
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.append(button);
    const originalGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = ((element: Element): CSSStyleDeclaration => {
      const style = originalGetComputedStyle.call(window, element);
      if (element !== button) return style;

      return new Proxy(style, {
        get: (target, property) => {
          if (property === "backgroundColor") {
            return "oklch(0.627 0.194 149.214)";
          }
          const value = Reflect.get(target, property, target) as unknown;

          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof window.getComputedStyle;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await settle(beacon);
      expect(signalsSent(sent, "invisible_text")).toHaveLength(0);
    } finally {
      window.getComputedStyle = originalGetComputedStyle;
      button.remove();
      document.body.style.backgroundColor = "";
    }
  });

  test("uses the browser color engine for every preserved CSS Color 4 space", async () => {
    const formats = [
      "oklab(0.627 -0.169 0.083)",
      "lab(50 40 30)",
      "lch(50 50 40)",
      "color(srgb 0 0.5 0)",
      "color(srgb-linear 0 0.5 0)",
      "color(display-p3 0 0.5 0)",
      "color(a98-rgb 0 0.5 0)",
      "color(prophoto-rgb 0 0.5 0)",
      "color(rec2020 0 0.5 0)",
      "color(xyz-d50 0.1 0.2 0.1)",
      "color(xyz-d65 0.1 0.2 0.1)",
    ];
    const buttons = formats.map((format) => {
      const button = document.createElement("button");
      button.dataset.testBackground = format;
      button.style.color = "rgb(255, 255, 255)";
      button.textContent = format;
      setRect(button, rectOf(0, 200, 0, 40));

      return button;
    });
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.append(...buttons);
    let assignedFillStyle = "";
    const convertedFormats = new Set<string>();
    const fakeContext = {
      clearRect: () => undefined,
      fillRect: () => undefined,
      get fillStyle() {
        return assignedFillStyle;
      },
      set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        assignedFillStyle = String(value);
        if (assignedFillStyle !== "#010203") {
          convertedFormats.add(assignedFillStyle);
        }
      },
      getImageData: () => ({
        data: new Uint8ClampedArray([0, 128, 0, 255]),
      }),
    } as unknown as CanvasRenderingContext2D;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalGetComputedStyle = window.getComputedStyle;
    HTMLCanvasElement.prototype.getContext = (() =>
      fakeContext) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    window.getComputedStyle = ((element: Element): CSSStyleDeclaration => {
      const style = originalGetComputedStyle.call(window, element);
      const background =
        element instanceof HTMLElement
          ? element.dataset.testBackground
          : undefined;
      if (background === undefined) return style;

      return new Proxy(style, {
        get: (target, property) => {
          if (property === "backgroundColor") return background;
          const value = Reflect.get(target, property, target) as unknown;

          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof window.getComputedStyle;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await settle(beacon);
      expect(signalsSent(sent, "invisible_text")).toHaveLength(0);
      expect([...convertedFormats]).toEqual(formats);
      await beacon.close();
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      window.getComputedStyle = originalGetComputedStyle;
      for (const button of buttons) button.remove();
      document.body.style.backgroundColor = "";
    }
  });

  test("skips contrast checks when an opaque background cannot be parsed", async () => {
    const button = document.createElement("button");
    button.textContent = "Future color";
    button.style.color = "rgb(255, 255, 255)";
    setRect(button, rectOf(0, 120, 0, 40));
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.append(button);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalGetComputedStyle = window.getComputedStyle;
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    window.getComputedStyle = ((element: Element): CSSStyleDeclaration => {
      const style = originalGetComputedStyle.call(window, element);
      if (element !== button) return style;

      return new Proxy(style, {
        get: (target, property) => {
          if (property === "backgroundColor") return "future-color(0.5 0.2 20)";
          const value = Reflect.get(target, property, target) as unknown;

          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof window.getComputedStyle;
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await settle(beacon);
      expect(signalsSent(sent, "invisible_text")).toHaveLength(0);
      await beacon.close();
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      window.getComputedStyle = originalGetComputedStyle;
      button.remove();
      document.body.style.backgroundColor = "";
    }
  });

  test("reports an opposite-polarity surface inside an adaptive theme boundary", async () => {
    document.documentElement.style.colorScheme = "dark";
    const boundary = document.createElement("main");
    boundary.setAttribute(BEACON_ATTRIBUTE.THEME, "adaptive");
    const card = document.createElement("section");
    card.className = "payment-card";
    card.textContent = "Payment complete";
    card.style.backgroundColor = "rgb(255, 255, 255)";
    setRect(card, rectOf(0, 300, 0, 100));
    boundary.append(card);
    document.body.append(boundary);
    const { beacon, sent } = makeWatchdogBeacon();
    await settle(beacon);
    const events = signalsSent(sent, "theme_mismatch");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      activeTheme: "dark",
      target: "section.payment-card",
    });
    boundary.remove();
    document.documentElement.style.colorScheme = "";
  });

  test("reports a small opposite-polarity interactive control", async () => {
    document.documentElement.style.colorScheme = "dark";
    const boundary = document.createElement("main");
    boundary.setAttribute(BEACON_ATTRIBUTE.THEME, "adaptive");
    const button = document.createElement("button");
    button.className = "light-only-action";
    button.textContent = "Open profile";
    button.style.backgroundColor = "rgb(255, 255, 255)";
    setRect(button, rectOf(0, 180, 0, 40));
    boundary.append(button);
    document.body.append(boundary);
    const { beacon, sent } = makeWatchdogBeacon();

    await settle(beacon);
    const events = signalsSent(sent, "theme_mismatch");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      activeTheme: "dark",
      target: "button.light-only-action",
    });
    boundary.remove();
    document.documentElement.style.colorScheme = "";
  });

  test("keeps the larger theme threshold for non-interactive surfaces", async () => {
    document.documentElement.style.colorScheme = "dark";
    const boundary = document.createElement("main");
    boundary.setAttribute(BEACON_ATTRIBUTE.THEME, "adaptive");
    const decoration = document.createElement("section");
    decoration.textContent = "Small intentional surface";
    decoration.style.backgroundColor = "rgb(255, 255, 255)";
    setRect(decoration, rectOf(0, 180, 0, 40));
    boundary.append(decoration);
    document.body.append(boundary);
    const { beacon, sent } = makeWatchdogBeacon();

    await settle(beacon);
    expect(signalsSent(sent, "theme_mismatch")).toHaveLength(0);
    boundary.remove();
    document.documentElement.style.colorScheme = "";
  });

  test("allows intentional opposite-theme surfaces", async () => {
    document.documentElement.style.colorScheme = "dark";
    const boundary = document.createElement("main");
    boundary.setAttribute(BEACON_ATTRIBUTE.THEME, "adaptive");
    const card = document.createElement("section");
    card.setAttribute(BEACON_ATTRIBUTE.THEME, "allow");
    card.textContent = "Intentional light preview";
    card.style.backgroundColor = "rgb(255, 255, 255)";
    setRect(card, rectOf(0, 300, 0, 100));
    boundary.append(card);
    document.body.append(boundary);
    const { beacon, sent } = makeWatchdogBeacon();
    await settle(beacon);
    expect(signalsSent(sent, "theme_mismatch")).toHaveLength(0);
    boundary.remove();
    document.documentElement.style.colorScheme = "";
  });

  test("recognizes explicit loading contracts", async () => {
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, stuckLoadingMs: 1 },
    });
    const spinner = document.createElement("span");
    spinner.setAttribute(BEACON_ATTRIBUTE.LOADING, "save-video");
    setRect(spinner, rectOf(0, 40, 0, 40));
    document.body.append(spinner);
    await settle(beacon);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await settle(beacon);
    expect(signalsSent(sent, "stuck_loading")).toHaveLength(1);
    spinner.remove();
  });

  test("honors an element-specific stuck-loading deadline", async () => {
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, stuckLoadingMs: 1 },
    });
    const stream = document.createElement("div");
    stream.setAttribute("aria-busy", "true");
    stream.setAttribute(BEACON_ATTRIBUTE.LOADING_TIMEOUT, "80");
    setRect(stream, rectOf(0, 400, 0, 240));
    document.body.append(stream);
    await settle(beacon);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await settle(beacon);
    expect(signalsSent(sent, "stuck_loading")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle(beacon);
    const events = signalsSent(sent, "stuck_loading");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.deadlineMs).toBe("80");
    stream.remove();
  });

  test("does not treat a determinate progressbar as a loading indicator", async () => {
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, stuckLoadingMs: 1 },
    });
    const progress = document.createElement("div");
    progress.setAttribute("aria-valuemax", "4");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuenow", "2");
    progress.setAttribute("role", "progressbar");
    setRect(progress, rectOf(0, 300, 0, 20));
    document.body.append(progress);
    await settle(beacon);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await settle(beacon);
    expect(signalsSent(sent, "stuck_loading")).toHaveLength(0);
    progress.remove();
  });

  test("still watches determinate progressbars explicitly marked busy", async () => {
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, stuckLoadingMs: 1 },
    });
    const progress = document.createElement("div");
    progress.setAttribute("aria-busy", "true");
    progress.setAttribute("aria-valuenow", "2");
    progress.setAttribute("role", "progressbar");
    setRect(progress, rectOf(0, 300, 0, 20));
    document.body.append(progress);
    await settle(beacon);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await settle(beacon);
    expect(signalsSent(sent, "stuck_loading")).toHaveLength(1);
    progress.remove();
  });

  test("reports a marked iframe that never loads", async () => {
    const frame = document.createElement("iframe");
    const originalDispatch = frame.dispatchEvent.bind(frame);
    frame.dispatchEvent = (event) =>
      event.type === "load" ? true : originalDispatch(event);
    frame.setAttribute(BEACON_ATTRIBUTE.EMBED, "qualification-survey");
    setRect(frame, rectOf(0, 400, 0, 300));
    document.body.append(frame);
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { embeddedContentStallMs: 1, layoutOverflowSettleMs: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    expect(signalsSent(sent, "embedded_content_stalled")).toHaveLength(1);
    frame.remove();
  });

  test("does not report a marked iframe that loads", async () => {
    const frame = document.createElement("iframe");
    frame.setAttribute(BEACON_ATTRIBUTE.EMBED, "document-preview");
    setRect(frame, rectOf(0, 400, 0, 300));
    document.body.append(frame);
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { embeddedContentStallMs: 1, layoutOverflowSettleMs: 0 },
    });
    frame.dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    expect(signalsSent(sent, "embedded_content_stalled")).toHaveLength(0);
    frame.remove();
  });

  test("reports a visible WebGL context that does not restore", async () => {
    const canvas = document.createElement("canvas");
    canvas.className = "voice-visualizer";
    setRect(canvas, rectOf(0, 200, 0, 200));
    document.body.append(canvas);
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, webglRestoreGraceMs: 1 },
    });
    canvas.dispatchEvent(new Event("webglcontextlost"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    expect(signalsSent(sent, "webgl_context_lost")).toHaveLength(1);
    canvas.remove();
  });

  test("does not report a WebGL context restored inside the grace period", async () => {
    const canvas = document.createElement("canvas");
    setRect(canvas, rectOf(0, 200, 0, 200));
    document.body.append(canvas);
    const { beacon, sent } = makeWatchdogBeacon({
      signals: { layoutOverflowSettleMs: 0, webglRestoreGraceMs: 5 },
    });
    canvas.dispatchEvent(new Event("webglcontextlost"));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    expect(signalsSent(sent, "webgl_context_lost")).toHaveLength(0);
    canvas.remove();
  });

  test("reports rejected clipboard writes without capturing their contents", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException("blocked", "NotAllowedError");
        },
      },
    });
    const button = document.createElement("button");
    button.className = "copy-link";
    document.body.append(button);
    button.focus();
    try {
      const { beacon, sent } = makeWatchdogBeacon();
      await navigator.clipboard
        .writeText("secret clipboard value")
        .catch(() => undefined);
      await beacon.flush();
      const events = signalsSent(sent, "clipboard_failure");
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0])).not.toContain("secret clipboard value");
    } finally {
      button.remove();
      if (originalClipboard === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      }
    }
  });

  test("reports a focused control left behind the mobile keyboard", async () => {
    const originalViewport = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const originalInnerHeight = Object.getOwnPropertyDescriptor(
      window,
      "innerHeight",
    );
    const viewport = Object.assign(new EventTarget(), {
      height: 500,
      offsetLeft: 0,
      offsetTop: 0,
      width: 1024,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    const input = document.createElement("input");
    input.className = "message-input";
    setRect(input, rectOf(0, 300, 700, 750));
    document.body.append(input);
    try {
      const { beacon, sent } = makeWatchdogBeacon({
        signals: { focusedControlSettleMs: 1, layoutOverflowSettleMs: 0 },
      });
      input.focus();
      viewport.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await beacon.flush();
      const events = signalsSent(sent, "focused_control_offscreen");
      expect(events).toHaveLength(1);
      expect(events[0]?.tags?.obscuredPx).toBe("250");
    } finally {
      input.remove();
      if (originalViewport === undefined) {
        Reflect.deleteProperty(window, "visualViewport");
      } else {
        Object.defineProperty(window, "visualViewport", originalViewport);
      }
      if (originalInnerHeight === undefined) {
        Reflect.deleteProperty(window, "innerHeight");
      } else {
        Object.defineProperty(window, "innerHeight", originalInnerHeight);
      }
    }
  });
});

describe("overlay awareness", () => {
  test("does not report occlusion while a fixed scrim owns the page", async () => {
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 800,
    });
    document.body.getBoundingClientRect = () =>
      ({
        bottom: 800,
        height: 800,
        left: 0,
        right: 1024,
        toJSON: () => ({}),
        top: 0,
        width: 1024,
        x: 0,
        y: 0,
      }) as DOMRect;
    const sent: BeaconEnvelope[] = [];
    const beacon = track(
      createBeacon({
        instrument: ALL_OFF,
        project: "web",
        signals: { layoutOverflowSettleMs: 0 },
        transport: ({ body }) => {
          sent.push(JSON.parse(body) as BeaconEnvelope);
        },
      }),
    );
    const button = document.createElement("button");
    button.getBoundingClientRect = () =>
      ({
        bottom: 140,
        height: 40,
        left: 100,
        right: 200,
        toJSON: () => ({}),
        top: 100,
        width: 100,
        x: 100,
        y: 100,
      }) as DOMRect;
    const scrim = document.createElement("div");
    scrim.style.position = "fixed";
    scrim.getBoundingClientRect = () =>
      ({
        bottom: 800,
        height: 800,
        left: 0,
        right: 1024,
        toJSON: () => ({}),
        top: 0,
        width: 1024,
        x: 0,
        y: 0,
      }) as DOMRect;
    document.body.append(button, scrim);
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => scrim;
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await beacon.flush();
    const occlusions = sent.flatMap((envelope) =>
      envelope.events.filter(
        (event) => event.tags?.signal === "occluded_control",
      ),
    );
    expect(occlusions).toHaveLength(0);
    button.remove();
    scrim.remove();
    await beacon.close();
    document.elementFromPoint = originalFromPoint;
  });
});
