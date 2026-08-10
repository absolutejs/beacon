/**
 * Runtime tests for @absolutejs/beacon (under happy-dom).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  BEACON_ATTRIBUTE,
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
  sessionStorage.removeItem("beacon:reload-history-v2");
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

  test.each([
    "Mozilla/5.0 (compatible; AdsBot-Google/2.1; +http://www.google.com/adsbot.html)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; BitSightBot/1.0)",
    "Mozilla/5.0 Dataprovider.com",
    "Mozilla/5.0 Google-NotebookLM",
    "Mozilla/5.0 (compatible; meta-externalagent/1.1; +https://developers.facebook.com/docs/sharing/webmasters/crawler)",
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
    expect(stack).toContain("applicationConsoleCaller");
    expect(stack).not.toContain("emitSignal");
    expect(stack).not.toContain("wrappedConsole");
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
        signals: { layoutOverflowSettleMs: 0 },
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
    await new Promise((resolve) => setTimeout(resolve, 70));
    await beacon.flush();
    expect(signalsSent(sent, "scroll_jail")).toHaveLength(1);
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
    }, 0);
    await new Promise((resolve) => setTimeout(resolve, 70));
    await beacon.flush();
    expect(signalsSent(sent, "scroll_jail")).toHaveLength(0);
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
              [210, 240, 280].map(
                (duration) =>
                  ({
                    duration,
                    entryType: "long-animation-frame",
                  }) as PerformanceEntry,
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
        entryType: "long-animation-frame",
        stallCount: "3",
      });
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
        if (options.type !== "event") return;
        const button = document.createElement("button");
        button.setAttribute(BEACON_ATTRIBUTE.NAME, "save-deal");
        this.callback(
          {
            getEntries: () => [
              {
                duration: 1240,
                entryType: "event",
                interactionId: 41,
                name: "click",
                target: button,
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
        durationMs: "1240",
        eventType: "click",
        interactionId: "41",
        target: "button[save-deal]",
      });
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
    input.dispatchEvent(new Event("input", { bubbles: true }));
    history.pushState(null, "", "/after-form");
    await beacon.flush();
    const events = signalsSent(sent, "form_abandonment");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      fieldCount: "1",
      target: "deal-editor",
    });
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
        this.dispatchEvent(new Event("close"));
      }
    }
    const original = window.WebSocket;
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const { beacon, sent } = makeWatchdogBeacon();
    for (let index = 0; index < 4; index += 1) {
      const socket = new window.WebSocket("wss://app.test/sync/ws");
      (socket as unknown as FakeWebSocket).serverClose();
    }
    await beacon.flush();
    const events = signalsSent(sent, "socket_flapping");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.endpoint).toBe("/sync/ws");
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
      "beacon:reload-history-v2",
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
    expect(events[0]?.tags?.loadCount).toBe("4");
    sessionStorage.removeItem("beacon:reload-history-v2");
  });

  test("does not call navigation across different routes a reload loop", async () => {
    const now = Date.now();
    sessionStorage.setItem(
      "beacon:reload-history-v2",
      JSON.stringify([
        { at: now - 3000, route: "/one" },
        { at: now - 2000, route: "/two" },
        { at: now - 1000, route: "/three" },
      ]),
    );
    const { beacon, sent } = makeWatchdogBeacon();
    await beacon.flush();
    expect(signalsSent(sent, "reload_loop")).toHaveLength(0);
    sessionStorage.removeItem("beacon:reload-history-v2");
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

  test("reports font faces that failed to load", async () => {
    const fakeFonts = {
      addEventListener: () => undefined,
      forEach: (
        callback: (face: { family: string; status: string }) => void,
      ) => {
        callback({ family: "Material Icons", status: "error" });
      },
      ready: Promise.resolve(),
      removeEventListener: () => undefined,
    };
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fakeFonts,
    });
    const { beacon, sent } = makeWatchdogBeacon();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await beacon.flush();
    const events = signalsSent(sent, "font_failure");
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.fontFamily).toBe("Material Icons");
    await beacon.close();
    Reflect.deleteProperty(document, "fonts");
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
