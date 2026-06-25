/**
 * @absolutejs/beacon — tiny, zero-dependency browser SDK for the AbsoluteJS
 * observability stack.
 *
 * It is deliberately NOT Effect-native: a browser SDK loads on every page for
 * every user, so bytes are the dominant cost (measured: an Effect client is
 * ~108 KB gz; this is ~2-5 KB gz). The client has no trust boundary — it's a
 * dumb producer of telemetry — so the Effect/Schema rigor lives server-side in
 * `@absolutejs/errors/ingest`, which validates the untrusted POST body.
 *
 * Type safety is preserved end-to-end WITHOUT shipping Effect: the envelope
 * type below is contract-locked to the ingest endpoint's accepted shape by a
 * compile-time assertion in tests (`tests/contract.test.ts`). The type spans
 * the wire; the runtime machinery does not.
 *
 *   captureException / global handlers
 *     → enrich (breadcrumbs, tags, context, replayId)
 *     → batch
 *     → flush: POST envelope to /ingest via sendBeacon / fetch keepalive
 */

export type BeaconLevel = "fatal" | "error" | "warning" | "info";

export type Breadcrumb = {
  /** `Date.now()` when recorded. */
  at: number;
  type: "console" | "click" | "navigation" | "fetch" | "xhr" | "custom";
  message: string;
  data?: Record<string, unknown>;
};

/** One captured occurrence — structurally the ingest endpoint's `BeaconEvent`. */
export type BeaconEvent = {
  name: string;
  message: string;
  level?: BeaconLevel;
  stack?: string;
  at?: number;
  traceId?: string;
  spanId?: string;
  replayId?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

/** The POST body — structurally the ingest endpoint's `BeaconEnvelope`. */
export type BeaconEnvelope = {
  v: 1;
  project: string;
  release?: string;
  environment?: string;
  events: BeaconEvent[];
};

export type CaptureContext = {
  level?: BeaconLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

/** Pluggable wire transport — injectable for tests / custom auth / proxies. */
export type BeaconTransport = (request: {
  url: string;
  body: string;
  key?: string;
  /** True on unload-time flushes — prefer `navigator.sendBeacon`. */
  useBeacon: boolean;
}) => void | Promise<void>;

export type BeaconInstrumentation = {
  /** `window.onerror` / `error` events. Default true. */
  globalErrors?: boolean;
  /** `unhandledrejection` events. Default true. */
  unhandledRejections?: boolean;
  /** Breadcrumb `console.error` / `console.warn`. Default true. */
  console?: boolean;
  /** Breadcrumb document clicks. Default true. */
  clicks?: boolean;
  /** Breadcrumb `fetch` calls. Default true. */
  fetch?: boolean;
  /** Breadcrumb `XMLHttpRequest` calls (legacy / third-party libs). Default true. */
  xhr?: boolean;
  /** Breadcrumb SPA navigations (`pushState`/`replaceState`/`popstate`). Default true. */
  history?: boolean;
};

/**
 * "Something went wrong" signal detection — the gap between captured errors and
 * full session streaming. Each enabled signal becomes a warning-level issue
 * (via `captureException`, so it carries breadcrumbs + the replayId), surfacing
 * silent problems no thrown error or user report would: rage/dead clicks,
 * server 5xx, slow/failed requests, and `console.error`. Reuses the existing
 * click / fetch / console instrumentation — no extra global patching.
 */
export type BeaconSignals = {
  /** N rapid clicks in roughly the same spot. Default true. */
  rageClicks?: boolean;
  /** An interactive control clicked with no DOM/nav/scroll/focus/request response. Default true. */
  deadClicks?: boolean;
  /** Responses with status >= 500. Default true. */
  serverErrors?: boolean;
  /** Responses slower than `slowResponseMs`. Default true. */
  slowResponses?: boolean;
  /** Requests that threw (network / CORS). Default true. */
  failedRequests?: boolean;
  /** `console.error` calls (the app explicitly logged an error). Default true. */
  consoleErrors?: boolean;
  /** Rapid-click count that trips a rage click. Default 3. */
  rageClickCount?: number;
  /** Slow-response threshold (ms). Default 8000. */
  slowResponseMs?: number;
};

export type BeaconOptions = {
  /** Project id (required) — scopes issues server-side. */
  project: string;
  /** Ingest endpoint URL. Default `/ingest`. */
  endpoint?: string;
  release?: string;
  environment?: string;
  /** Auth key, sent as `x-beacon-key` (forces `fetch` over `sendBeacon`). */
  key?: string;
  /** Auto-flush once this many events are buffered. Default 30. */
  maxBatch?: number;
  /** Auto-flush interval (ms). Default 5000. */
  flushIntervalMs?: number;
  /** Breadcrumbs retained (ring buffer). Default 30. */
  maxBreadcrumbs?: number;
  /** Sample rate 0..1 — fraction of events kept. Default 1. */
  sampleRate?: number;
  /** Mutate or drop (return null) each event before it's buffered. */
  beforeSend?: (event: BeaconEvent) => BeaconEvent | null;
  /** Supply the active session-replay id (wired by @absolutejs/replay). */
  getReplayId?: () => string | undefined;
  /** Auto-instrumentation toggles (all default true). */
  instrument?: BeaconInstrumentation;
  /** Auto-capture UX/health signals as warning issues (off by default). `true`
   *  enables all with defaults; pass an object to tune. See {@link BeaconSignals}. */
  signals?: boolean | BeaconSignals;
  /** Capture Core Web Vitals (off by default). See {@link BeaconVitalsOptions}. */
  vitals?: boolean | BeaconVitalsOptions;
  /** Override the wire transport (default: sendBeacon / fetch keepalive). */
  transport?: BeaconTransport;
};

/** A finalized Core Web Vital measurement, tagged with the path it was seen on. */
export type WebVital = {
  /** The 5 Core Web Vitals, plus TBT (Total Blocking Time — long-task overage). */
  name: "LCP" | "INP" | "CLS" | "FCP" | "TTFB" | "TBT";
  /** Metric value (ms for LCP/INP/FCP/TTFB; unitless for CLS). */
  value: number;
  rating: "good" | "needs-improvement" | "poor";
  /** URL path the vital was measured on (for per-route p75). */
  path: string;
  /** Stable per-page-load metric id (dedup). */
  id: string;
  navigationType: string;
};

type WebVitalMetric = {
  name: string;
  value: number;
  rating: string;
  id: string;
  navigationType: string;
};
type WebVitalReporter = (callback: (metric: WebVitalMetric) => void) => void;
/** The subset of the `web-vitals` package surface beacon uses. */
export type WebVitalsModule = {
  onLCP: WebVitalReporter;
  onINP: WebVitalReporter;
  onCLS: WebVitalReporter;
  onFCP: WebVitalReporter;
  onTTFB: WebVitalReporter;
};

/**
 * Core Web Vitals capture. Uses the `web-vitals` package as an OPTIONAL,
 * lazy-loaded peer (like rrweb for @absolutejs/replay) — install it
 * (`bun add web-vitals`) to enable, or inject `webVitals` for tests. Each
 * metric is reported once, finalized, and `sendBeacon`'d so it survives unload.
 */
export type BeaconVitalsOptions = {
  /** Where to POST each vital. Default `/ingest/vitals`. */
  endpoint?: string;
  /** Inject the web-vitals fns (default: lazy `import("web-vitals")`). */
  webVitals?: WebVitalsModule;
  /** Also called for each finalized vital (in addition to the POST). */
  onVital?: (vital: WebVital) => void;
};

export type Beacon = {
  captureException: (error: unknown, context?: CaptureContext) => void;
  captureMessage: (message: string, level?: BeaconLevel) => void;
  addBreadcrumb: (crumb: {
    message: string;
    type?: Breadcrumb["type"];
    data?: Record<string, unknown>;
  }) => void;
  /** Merge persistent tags applied to every subsequent event. */
  setTags: (tags: Record<string, string>) => void;
  /** Set (or clear, with null) the user attached to events. */
  setUser: (user: { id?: string; email?: string } | null) => void;
  /** Flush buffered events now. */
  flush: () => Promise<void>;
  /** Remove all listeners + do a final flush. */
  close: () => Promise<void>;
};

// =============================================================================
// Helpers
// =============================================================================

const inBrowser = (): boolean => typeof window !== "undefined";

const newId = (): string => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const toError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  if (typeof value === "object" && value !== null) {
    const object = value as { message?: unknown; name?: unknown };
    const message =
      typeof object.message === "string"
        ? object.message
        : safeStringify(value);
    const error = new Error(message);
    if (typeof object.name === "string") error.name = object.name;
    return error;
  }
  return new Error(String(value));
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const describeElement = (element: Element): string => {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const cls =
    typeof element.className === "string" && element.className.trim() !== ""
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
  return `${tag}${id}${cls}`;
};

const SHORT_URL_MAX = 80;
const shortUrl = (url: string): string => {
  try {
    return new URL(url, location.origin).pathname;
  } catch {
    return url.slice(0, SHORT_URL_MAX);
  }
};

// An anchor whose click does something invisible to us (new tab / download /
// off-site nav) — so "nothing changed on this page" doesn't make it "dead".
const isInvisibleAnchor = (anchor: HTMLAnchorElement): boolean => {
  if (anchor.target === "_blank" || anchor.hasAttribute("download")) return true;
  try {
    return new URL(anchor.href, location.origin).origin !== location.origin;
  } catch {
    return true;
  }
};

// A control we'd expect to DO something when clicked (else null) — used for
// dead-click detection.
const deadClickCandidate = (target: Element): Element | null => {
  const control = target.closest<HTMLElement>(
    "button, a[href], [role='button'], input[type='submit'], input[type='button'], [onclick]",
  );
  if (control === null) return null;
  if (
    control.hasAttribute("disabled") ||
    control.getAttribute("aria-disabled") === "true"
  ) {
    return null;
  }
  if (control instanceof HTMLAnchorElement && isInvisibleAnchor(control)) {
    return null;
  }
  return control;
};

const VITAL_NAMES = new Set(["LCP", "INP", "CLS", "FCP", "TTFB", "TBT"]);
const LONG_TASK_MS = 50;
const TBT_GOOD_MS = 200;
const TBT_POOR_MS = 600;

// Observe long tasks (>50ms) and report Total Blocking Time (sum of per-task
// overage) once on page-hide — the jank / INP precursor the CWV libs don't give.
const observeLongTasks = (
  report: (metric: WebVitalMetric) => void,
  navigationType: string,
): void => {
  if (typeof PerformanceObserver === "undefined") return;
  let totalBlockingMs = 0;
  let count = 0;
  let reported = false;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        totalBlockingMs += Math.max(0, entry.duration - LONG_TASK_MS);
        count += 1;
      }
    });
    observer.observe({ buffered: true, type: "longtask" });
    const flush = (): void => {
      if (reported || count === 0 || document.visibilityState !== "hidden") {
        return;
      }
      reported = true;
      const value = Math.round(totalBlockingMs);
      report({
        id: `tbt-${navigationType}-${value}`,
        name: "TBT",
        navigationType,
        rating:
          value <= TBT_GOOD_MS
            ? "good"
            : value >= TBT_POOR_MS
              ? "poor"
              : "needs-improvement",
        value,
      });
    };
    addEventListener("visibilitychange", flush);
    addEventListener("pagehide", flush);
  } catch {
    // longtask entry type unsupported — skip
  }
};
const isVitalName = (name: string): name is WebVital["name"] =>
  VITAL_NAMES.has(name);

const loadWebVitals = async (): Promise<WebVitalsModule> => {
  const mod = (await import("web-vitals")) as unknown as WebVitalsModule;

  return mod;
};

// Register the 5 Core Web Vitals; each fires once when finalized (at
// visibilitychange / pagehide). `report` should be sendBeacon-backed so the
// value survives the page going away.
const observeWebVitals = (
  webVitals: WebVitalsModule,
  report: (metric: WebVitalMetric) => void,
): void => {
  webVitals.onLCP(report);
  webVitals.onINP(report);
  webVitals.onCLS(report);
  webVitals.onFCP(report);
  webVitals.onTTFB(report);
};

const noopBeacon: Beacon = {
  addBreadcrumb: () => {},
  captureException: () => {},
  captureMessage: () => {},
  close: async () => {},
  flush: async () => {},
  setTags: () => {},
  setUser: () => {},
};

// =============================================================================
// Default transport — sendBeacon on unload, fetch keepalive otherwise
// =============================================================================

const defaultTransport: BeaconTransport = ({ url, body, key, useBeacon }) => {
  if (typeof navigator === "undefined") return;
  // sendBeacon can't set headers, so it's only usable when there's no key.
  if (
    useBeacon &&
    key === undefined &&
    typeof navigator.sendBeacon === "function"
  ) {
    navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    return;
  }
  if (typeof fetch === "function") {
    void fetch(url, {
      body,
      headers: {
        "content-type": "application/json",
        ...(key !== undefined ? { "x-beacon-key": key } : {}),
      },
      keepalive: true,
      method: "POST",
    }).catch(() => {
      // Telemetry is best-effort; a failed POST must never surface to the app.
    });
  }
};

// =============================================================================
// createBeacon
// =============================================================================

export const createBeacon = (options: BeaconOptions): Beacon => {
  if (!inBrowser()) return noopBeacon; // SSR / non-DOM import is a no-op

  const endpoint = options.endpoint ?? "/ingest";
  const maxBatch = options.maxBatch ?? 30;
  const flushIntervalMs = options.flushIntervalMs ?? 5000;
  const maxBreadcrumbs = options.maxBreadcrumbs ?? 30;
  const sampleRate = options.sampleRate ?? 1;
  const transport = options.transport ?? defaultTransport;
  const instrument = options.instrument ?? {};
  const sessionId = newId();

  // Signal detection (off unless `signals` is set). `true` ⇒ all defaults.
  const signals: BeaconSignals | null =
    options.signals === undefined || options.signals === false
      ? null
      : options.signals === true
        ? {}
        : options.signals;
  const SLOW_RESPONSE_DEFAULT_MS = 8000;
  const RAGE_COUNT_DEFAULT = 3;
  const RAGE_WINDOW_MS = 1000;
  const RAGE_RADIUS_PX = 40;
  const DEAD_CLICK_WINDOW_MS = 1500;
  const SIGNAL_TEXT_MAX = 180;
  const slowResponseMs = signals?.slowResponseMs ?? SLOW_RESPONSE_DEFAULT_MS;
  const rageCount = signals?.rageClickCount ?? RAGE_COUNT_DEFAULT;
  // Last request kick-off — a click that triggers a request isn't "dead".
  let lastNetworkAt = 0;
  let inSignalConsole = false;

  // Core Web Vitals (off unless `vitals` is set). `true` ⇒ all defaults.
  const vitalsOptions: BeaconVitalsOptions | null =
    options.vitals === undefined || options.vitals === false
      ? null
      : options.vitals === true
        ? {}
        : options.vitals;
  if (vitalsOptions !== null) {
    const vitalsEndpoint = vitalsOptions.endpoint ?? "/ingest/vitals";
    const reportVital = (metric: WebVitalMetric): void => {
      if (!isVitalName(metric.name)) return;
      const vital: WebVital = {
        id: metric.id,
        name: metric.name,
        navigationType: metric.navigationType,
        path: location.pathname,
        rating:
          metric.rating === "good" ||
          metric.rating === "needs-improvement" ||
          metric.rating === "poor"
            ? metric.rating
            : "needs-improvement",
        value: metric.value,
      };
      vitalsOptions.onVital?.(vital);
      const body = JSON.stringify(vital);
      // sendBeacon survives unload (vitals finalize at pagehide); fetch fallback.
      if (typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(
          vitalsEndpoint,
          new Blob([body], { type: "application/json" }),
        );
      } else if (typeof fetch === "function") {
        void fetch(vitalsEndpoint, {
          body,
          headers: { "content-type": "application/json" },
          keepalive: true,
          method: "POST",
        }).catch(() => {
          // best-effort telemetry
        });
      }
    };
    if (vitalsOptions.webVitals !== undefined) {
      observeWebVitals(vitalsOptions.webVitals, reportVital);
    } else {
      loadWebVitals()
        .then((webVitals) => observeWebVitals(webVitals, reportVital))
        .catch(() => {
          console.warn(
            "[beacon] web-vitals not installed; vitals disabled. `bun add web-vitals`.",
          );
        });
    }
    const navigationEntry = performance.getEntriesByType("navigation")[0];
    const navigationType =
      navigationEntry instanceof PerformanceNavigationTiming
        ? navigationEntry.type
        : "navigate";
    observeLongTasks(reportVital, navigationType);
  }

  const buffer: BeaconEvent[] = [];
  const breadcrumbs: Breadcrumb[] = [];
  const cleanups: Array<() => void> = [];
  let tags: Record<string, string> = {};
  let user: { id?: string; email?: string } | undefined;

  const flush = async (useBeacon = false): Promise<void> => {
    if (buffer.length === 0) return;
    const events = buffer.splice(0, buffer.length);
    const envelope: BeaconEnvelope = {
      events,
      project: options.project,
      v: 1,
      ...(options.release !== undefined ? { release: options.release } : {}),
      ...(options.environment !== undefined
        ? { environment: options.environment }
        : {}),
    };
    await transport({
      body: JSON.stringify(envelope),
      url: endpoint,
      useBeacon,
      ...(options.key !== undefined ? { key: options.key } : {}),
    });
  };

  const addBreadcrumb: Beacon["addBreadcrumb"] = (crumb) => {
    breadcrumbs.push({
      at: Date.now(),
      message: crumb.message.slice(0, 200),
      type: crumb.type ?? "custom",
      ...(crumb.data !== undefined ? { data: crumb.data } : {}),
    });
    while (breadcrumbs.length > maxBreadcrumbs) breadcrumbs.shift();
  };

  const enrich = (event: BeaconEvent): BeaconEvent | null => {
    if (sampleRate < 1 && Math.random() > sampleRate) return null;
    const enriched: BeaconEvent = { ...event, at: event.at ?? Date.now() };
    const replayId = options.getReplayId?.();
    if (replayId !== undefined) enriched.replayId = replayId;
    const mergedTags = { ...tags, ...event.tags };
    if (Object.keys(mergedTags).length > 0) enriched.tags = mergedTags;
    const extra: Record<string, unknown> = { sessionId, ...event.extra };
    if (breadcrumbs.length > 0) extra.breadcrumbs = [...breadcrumbs];
    if (user !== undefined) extra.user = user;
    enriched.extra = extra;
    return options.beforeSend !== undefined
      ? options.beforeSend(enriched)
      : enriched;
  };

  const push = (event: BeaconEvent): void => {
    const enriched = enrich(event);
    if (enriched === null) return;
    buffer.push(enriched);
    if (buffer.length >= maxBatch) void flush();
  };

  const captureException: Beacon["captureException"] = (
    error,
    context = {},
  ) => {
    const resolved = toError(error);
    const event: BeaconEvent = {
      level: context.level ?? "error",
      message: resolved.message,
      name: resolved.name,
    };
    if (resolved.stack !== undefined) event.stack = resolved.stack;
    if (context.tags !== undefined) event.tags = context.tags;
    if (context.extra !== undefined) event.extra = context.extra;
    push(event);
  };

  const captureMessage: Beacon["captureMessage"] = (
    message,
    level = "info",
  ) => {
    push({ level, message, name: "Message" });
  };

  // A signal is a warning-level capture with a stable message (so the store
  // groups it) and the variable detail in tags.
  const emitSignal = (
    message: string,
    signalTags: Record<string, string>,
  ): void => {
    captureException(new Error(message), {
      level: "warning",
      tags: signalTags,
    });
  };

  const reportResponseSignal = (
    url: string,
    status: number,
    durationMs: number,
  ): void => {
    if (signals === null) return;
    if (signals.serverErrors !== false && status >= 500) {
      emitSignal("Server error response (5xx)", {
        endpoint: shortUrl(url),
        signal: "http_5xx",
        status: String(status),
      });
      return;
    }
    if (signals.slowResponses !== false && durationMs > slowResponseMs) {
      emitSignal("Slow response", {
        durationMs: String(durationMs),
        endpoint: shortUrl(url),
        signal: "slow_response",
      });
    }
  };

  const reportFailureSignal = (url: string): void => {
    if (signals === null || signals.failedRequests === false) return;
    emitSignal("Network request failed", {
      endpoint: shortUrl(url),
      signal: "fetch_failed",
    });
  };

  // A control clicked with no response (DOM mutation / nav / scroll / focus /
  // request) within the window — a likely broken control.
  const detectDeadClick = (target: Element): void => {
    const control = deadClickCandidate(target);
    if (control === null) return;
    const urlBefore = location.href;
    const scrollBefore = window.scrollY;
    const activeBefore = document.activeElement;
    const clickedAt = Date.now();
    let mutated = false;
    const observer = new MutationObserver(() => {
      mutated = true;
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.setTimeout(() => {
      observer.disconnect();
      const responded =
        mutated ||
        location.href !== urlBefore ||
        window.scrollY !== scrollBefore ||
        document.activeElement !== activeBefore ||
        lastNetworkAt > clickedAt;
      if (responded) return;
      emitSignal("Dead click — control didn't respond", {
        signal: "dead_click",
        target: describeElement(control),
      });
    }, DEAD_CLICK_WINDOW_MS);
  };

  // --- auto-instrumentation -------------------------------------------------

  if (instrument.globalErrors !== false) {
    const onError = (event: ErrorEvent): void => {
      const error =
        event.error instanceof Error
          ? event.error
          : new Error(event.message || "Uncaught error");
      captureException(error, { level: "error" });
    };
    window.addEventListener("error", onError, true);
    cleanups.push(() => window.removeEventListener("error", onError, true));
  }

  if (instrument.unhandledRejections !== false) {
    const onRejection = (event: PromiseRejectionEvent): void => {
      const reason = event.reason;
      if (reason instanceof Error) {
        captureException(reason, { level: "error" });
        return;
      }
      const error = new Error(
        typeof reason === "string" ? reason : safeStringify(reason),
      );
      error.name = "UnhandledRejection";
      captureException(error, { level: "error" });
    };
    window.addEventListener("unhandledrejection", onRejection);
    cleanups.push(() =>
      window.removeEventListener("unhandledrejection", onRejection),
    );
  }

  if (instrument.console !== false && typeof console !== "undefined") {
    for (const method of ["error", "warn"] as const) {
      const original = console[method];
      console[method] = (...args: unknown[]): void => {
        addBreadcrumb({
          message: `console.${method}: ${args.map(String).join(" ")}`,
          type: "console",
        });
        if (
          method === "error" &&
          signals !== null &&
          signals.consoleErrors !== false &&
          !inSignalConsole
        ) {
          inSignalConsole = true;
          const text = args.map(String).join(" ").trim().slice(0, SIGNAL_TEXT_MAX);
          if (text !== "") emitSignal(text, { signal: "console_error" });
          inSignalConsole = false;
        }
        original.apply(console, args);
      };
      cleanups.push(() => {
        console[method] = original;
      });
    }
  }

  if (instrument.clicks !== false && typeof document !== "undefined") {
    let clickTimes: number[] = [];
    let lastX = 0;
    let lastY = 0;
    const onClick = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      addBreadcrumb({ message: describeElement(target), type: "click" });
      if (signals === null) return;
      if (signals.rageClicks !== false && event instanceof MouseEvent) {
        const now = Date.now();
        const near =
          Math.abs(event.clientX - lastX) < RAGE_RADIUS_PX &&
          Math.abs(event.clientY - lastY) < RAGE_RADIUS_PX;
        lastX = event.clientX;
        lastY = event.clientY;
        clickTimes = near
          ? clickTimes.filter((time) => now - time < RAGE_WINDOW_MS)
          : [];
        clickTimes.push(now);
        if (clickTimes.length >= rageCount) {
          clickTimes = [];
          emitSignal("Rage click — repeated clicks with no response", {
            signal: "rage_click",
            target: describeElement(target),
          });
        }
      }
      if (signals.deadClicks !== false) detectDeadClick(target);
    };
    document.addEventListener("click", onClick, true);
    cleanups.push(() => document.removeEventListener("click", onClick, true));
  }

  if (instrument.fetch !== false && typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    const wrapped = async (
      ...args: Parameters<typeof fetch>
    ): Promise<Response> => {
      const [input, init] = args;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? "GET";
      // Never breadcrumb our own ingest POSTs — avoids a feedback loop.
      if (url.includes(endpoint)) return originalFetch(...args);
      const start = Date.now();
      lastNetworkAt = start;
      try {
        const response = await originalFetch(...args);
        addBreadcrumb({
          data: { status: response.status },
          message: `${method} ${url} → ${response.status}`,
          type: "fetch",
        });
        reportResponseSignal(url, response.status, Date.now() - start);
        return response;
      } catch (error) {
        addBreadcrumb({ message: `${method} ${url} → failed`, type: "fetch" });
        reportFailureSignal(url);
        throw error;
      }
    };
    window.fetch = wrapped as typeof window.fetch;
    cleanups.push(() => {
      window.fetch = originalFetch;
    });
  }

  if (instrument.xhr !== false && typeof XMLHttpRequest !== "undefined") {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    // Per-request method/url, keyed off the instance without patching it.
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      meta.set(this, { method: String(method), url: String(url) });

      return originalOpen.apply(
        this,
        [method, url, ...rest] as Parameters<typeof originalOpen>,
      );
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest["send"]>
    ) {
      const request = meta.get(this);
      // Never breadcrumb our own ingest POSTs — avoids a feedback loop.
      if (request !== undefined && !request.url.includes(endpoint)) {
        this.addEventListener("loadend", () => {
          addBreadcrumb({
            data: { status: this.status },
            message: `${request.method} ${request.url} → ${this.status || "failed"}`,
            type: "xhr",
          });
        });
      }

      return originalSend.apply(this, args);
    };
    cleanups.push(() => {
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
    });
  }

  if (instrument.history !== false && typeof history !== "undefined") {
    const record = (): void =>
      addBreadcrumb({
        message: `navigate ${location.pathname}${location.search}`,
        type: "navigation",
      });
    const patch = (key: "pushState" | "replaceState"): (() => void) => {
      const original = history[key].bind(history);
      history[key] = (...args: Parameters<History["pushState"]>) => {
        const result = original(...args);
        record();
        return result;
      };
      return () => {
        history[key] = original;
      };
    };
    cleanups.push(patch("pushState"), patch("replaceState"));
    window.addEventListener("popstate", record);
    cleanups.push(() => window.removeEventListener("popstate", record));
  }

  // Flush on a timer + when the page is hidden / unloaded (the reliable moment).
  const timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  (timer as { unref?: () => void }).unref?.();
  cleanups.push(() => clearInterval(timer));

  const onHide = (): void => {
    void flush(true);
  };
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onHide();
  });
  cleanups.push(() => window.removeEventListener("pagehide", onHide));

  return {
    addBreadcrumb,
    captureException,
    captureMessage,
    close: async () => {
      for (const cleanup of cleanups.splice(0, cleanups.length)) cleanup();
      await flush(true);
    },
    flush: () => flush(false),
    setTags: (next) => {
      tags = { ...tags, ...next };
    },
    setUser: (next) => {
      user = next ?? undefined;
    },
  };
};

// =============================================================================
// Singleton convenience (Sentry-style global API)
// =============================================================================

let current: Beacon | undefined;

/** Initialize the global beacon. Returns the instance. */
export const initBeacon = (options: BeaconOptions): Beacon => {
  current = createBeacon(options);
  return current;
};

/** The global beacon, if `initBeacon` has been called. */
export const getBeacon = (): Beacon | undefined => current;

/** Capture against the global beacon (no-op if uninitialized). */
export const captureException = (
  error: unknown,
  context?: CaptureContext,
): void => current?.captureException(error, context);

/** Capture a message against the global beacon (no-op if uninitialized). */
export const captureMessage = (message: string, level?: BeaconLevel): void =>
  current?.captureMessage(message, level);

/** Add a breadcrumb to the global beacon (no-op if uninitialized). */
export const addBreadcrumb = (crumb: {
  message: string;
  type?: Breadcrumb["type"];
  data?: Record<string, unknown>;
}): void => current?.addBreadcrumb(crumb);
