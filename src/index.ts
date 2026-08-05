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

/** Stable names for Beacon's built-in UX and health signals. */
export const BEACON_SIGNAL = {
  CONSOLE_ERROR: "console_error",
  DEAD_CLICK: "dead_click",
  FETCH_FAILED: "fetch_failed",
  FOCUS_LOST: "focus_lost",
  FONT_FAILURE: "font_failure",
  FORM_FRUSTRATION: "form_frustration",
  HTTP_5XX: "http_5xx",
  INVISIBLE_TEXT: "invisible_text",
  LAYOUT_OVERFLOW: "layout_overflow",
  OCCLUDED_CONTROL: "occluded_control",
  RAGE_CLICK: "rage_click",
  RELOAD_LOOP: "reload_loop",
  REQUEST_STORM: "request_storm",
  SCROLL_JAIL: "scroll_jail",
  SLOW_RESPONSE: "slow_response",
  SOCKET_FLAPPING: "socket_flapping",
  STALE_RELEASE: "stale_release",
  STALLED_STREAM: "stalled_stream",
  STUCK_LOADING: "stuck_loading",
} as const;

export type BeaconSignal = (typeof BEACON_SIGNAL)[keyof typeof BEACON_SIGNAL];

/** Stable DOM attributes understood by Beacon's instrumentation. */
export const BEACON_ATTRIBUTE = {
  DEAD_CLICK: "data-beacon-dead-click",
  NAME: "data-beacon-name",
  /** `="allow"` exempts an element AND its subtree from layout-overflow
   * detection — for deliberate bleeds (decorative shapes, marquees). */
  OVERFLOW: "data-beacon-overflow",
  /** `="allow"` exempts an element AND its subtree from the visual scan
   * detectors (occluded controls, invisible text, stuck loading). */
  SCAN: "data-beacon-scan",
} as const;

/** Response header used to correlate a browser signal with its server request. */
export const BEACON_TRACE_HEADER = "x-absolute-trace-id";

/** Arbitrary event tags, with Beacon's reserved `signal` tag type-checked. */
export type BeaconTags = Record<string, string> & {
  signal?: BeaconSignal;
};

export type Breadcrumb = {
  /** `Date.now()` when recorded. */
  at: number;
  type: "console" | "click" | "navigation" | "fetch" | "xhr" | "custom";
  message: string;
  data?: Record<string, unknown>;
};

/** One captured occurrence — structurally the ingest endpoint's `BeaconEvent`. */
export type BeaconEvent = {
  /** Stable semantic issue identity for synthetic/integration failures. The
   * ingest service hashes this key; raw client fingerprints are never trusted. */
  groupingKey?: string;
  name: string;
  message: string;
  level?: BeaconLevel;
  stack?: string;
  at?: number;
  traceId?: string;
  spanId?: string;
  replayId?: string;
  tags?: BeaconTags;
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
  /** Override stack/message grouping with a stable semantic issue identity. */
  groupingKey?: string;
  level?: BeaconLevel;
  traceId?: string;
  spanId?: string;
  tags?: BeaconTags;
  extra?: Record<string, unknown>;
};

export type CaptureMessageContext = Omit<CaptureContext, "level">;

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
  /**
   * Resource-load errors captured by the global `error` listener. Default true.
   * A predicate can keep a failure as an error, downgrade it to a grouped
   * warning, or return false to drop it.
   */
  resourceErrors?:
    boolean | ((failure: BeaconResourceFailure) => "error" | "warning" | false);
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

export type BeaconResourceFailure = {
  crossOrigin: boolean;
  target: string;
  type: string;
  url?: string;
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
  /** A focused element inside an open dialog removed from the DOM with focus
   *  falling to `<body>` — keyboard users stranded. Default true. */
  focusLoss?: boolean;
  /** `FontFace` loads that end in `status: "error"` — icon fonts falling back
   *  to raw ligature text, custom faces silently missing. Default true. */
  fontFailures?: boolean;
  /** The same form submitted or failing native validation repeatedly within a
   *  minute — the quiet sibling of a rage click. Default true. */
  formFrustration?: boolean;
  /** Sampled scan for text rendered nearly the same color as its opaque
   *  background (theme-token bugs). Default true. */
  invisibleText?: boolean;
  /**
   * Elements that visibly break their bounds once layout settles (first load,
   * resize end, SPA navigation): in-flow elements crossing the viewport's
   * horizontal edges, children painting past a non-scrolling parent, and
   * content cut by `overflow: hidden` without an ellipsis treatment. Subtrees
   * of scroll containers and absolutely positioned escapees (badges,
   * popovers, drawers) are skipped by design. Default true.
   */
  layoutOverflows?: boolean;
  /** Maximum layout-overflow issues reported per page load. Default 5. */
  layoutOverflowMaxReports?: number;
  /** Quiet period after load/resize/navigation before the settled visual
   *  scan runs, letting transitions and lazy content settle. Default 600ms. */
  layoutOverflowSettleMs?: number;
  /** Sampled `elementFromPoint` check for interactive controls covered by an
   *  unrelated element (leaked scrims, z-index bugs). Skipped entirely while
   *  a dialog is open. Default true. */
  occludedControls?: boolean;
  /** Rapid-click count that trips a rage click. Default 3. */
  rageClickCount?: number;
  /** Several full page loads within a minute — a crash or reload loop.
   *  Default true. */
  reloadLoops?: boolean;
  /** The same endpoint hit `requestStormCount` times inside
   *  `requestStormWindowMs` — refetch loops and retry storms. Needs the
   *  fetch/XHR instrumentation. Default true. */
  requestStorms?: boolean;
  /** Requests to one endpoint that trip a storm. Default 15. */
  requestStormCount?: number;
  /** Window for the request-storm counter. Default 10000ms. */
  requestStormWindowMs?: number;
  /** Repeated wheel/touch input while the scrollable page never moves — a
   *  scroll lock leaked by a closed modal. Boundary scrolling (already at the
   *  top/bottom) is exempt. Default true. */
  scrollJail?: boolean;
  /** WebSocket connect/close cycles to one URL tripping a flap report.
   *  Default true. */
  socketFlapping?: boolean;
  /** This page's `release` is older than one this browser has already run —
   *  a service worker or cache serving a stale build. Default true. */
  staleReleases?: boolean;
  /** An open `EventSource` on a visible page with no message for
   *  `stalledStreamMs` — the silent-stream failure. Default true. */
  stalledStreams?: boolean;
  /** Quiet period before an open, visible EventSource counts as stalled.
   *  Default 60000ms. */
  stalledStreamMs?: number;
  /** An `aria-busy`/`role="status"`/`role="progressbar"` element still
   *  visible after `stuckLoadingMs` — a load that silently hung.
   *  Default true. */
  stuckLoading?: boolean;
  /** Age at which a visible loading indicator counts as stuck.
   *  Default 20000ms. */
  stuckLoadingMs?: number;
  /**
   * Maximum wait for a same-origin link accepted by an SPA router to finish
   * navigating before it is considered dead. Default 8000ms; never shorter
   * than the normal 1500ms dead-click window.
   */
  navigationResponseMs?: number;
  /** Slow-response threshold (ms). Default 8000. */
  slowResponseMs?: number;
};

export type BeaconNetworkFailure = {
  at: number;
  durationMs: number;
  endpoint: string;
  error: {
    message: string;
    name: string;
    properties?: Record<string, unknown>;
    stack?: string;
  };
  method: string;
  online: boolean | null;
  transport: "fetch" | "xhr";
  visibilityState: string;
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
  /**
   * Redact credentials, secret-bearing fields, and URL query/hash values after
   * `beforeSend` and before buffering. Default true. Disable only when an
   * equivalent trusted boundary owns redaction.
   */
  redact?: boolean;
  /**
   * Drop signatures known to come from browser hosts/scanners rather than the
   * page, such as CefSharp's JavaScript bridge rejections. Default true.
   */
  filterKnownNoise?: boolean;
  /** Supply the active session-replay id (wired by @absolutejs/replay). */
  getReplayId?: () => string | undefined;
  /** Supply the active W3C trace id for cross-signal correlation. */
  getTraceId?: () => string | undefined;
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
  /** Unix epoch milliseconds when the finalized metric was observed. */
  at: number;
  /** Optional deployment environment copied from the Beacon configuration. */
  environment?: string;
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
  /** Beacon project identifier, used by authenticated relays for tenant fencing. */
  project: string;
  /** Optional application release copied from the Beacon configuration. */
  release?: string;
  /** Optional privacy-masked replay correlation. */
  replayId?: string;
  /** Fraction of eligible observations represented by this event. */
  samplingRate: number;
  /** Version of this telemetry envelope. */
  schemaVersion: number;
  /** Beacon SDK version supplied by the host build. */
  sdkVersion?: string;
  /** Optional W3C trace correlation. */
  traceId?: string;
};

/** Override Web Vital delivery without changing collection semantics. */
export type BeaconVitalsTransport = (vital: WebVital) => void | Promise<void>;

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
  /** Fraction of eligible page loads sampled. Default 1. */
  samplingRate?: number;
  /** Telemetry envelope version. Default 1. */
  schemaVersion?: number;
  /** SDK/build version retained with the measurement. */
  sdkVersion?: string;
  /** Override delivery (default: sendBeacon / fetch keepalive). */
  transport?: BeaconVitalsTransport;
};

export type Beacon = {
  captureException: (error: unknown, context?: CaptureContext) => void;
  captureMessage: (
    message: string,
    level?: BeaconLevel,
    context?: CaptureMessageContext,
  ) => void;
  addBreadcrumb: (crumb: {
    message: string;
    type?: Breadcrumb["type"];
    data?: Record<string, unknown>;
  }) => void;
  /** Merge persistent tags applied to every subsequent event. */
  setTags: (tags: BeaconTags) => void;
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
    const object = value as {
      cause?: unknown;
      message?: unknown;
      name?: unknown;
      stack?: unknown;
    };
    const message =
      typeof object.message === "string"
        ? object.message
        : safeStringify(value);
    const error = new Error(message);
    if (typeof object.name === "string") error.name = object.name;
    if (typeof object.stack === "string") error.stack = object.stack;
    if (object.cause !== undefined) error.cause = object.cause;
    return error;
  }
  return new Error(String(value));
};

type CapturedErrorCause = {
  name: string;
  message: string;
  stack?: string;
  properties?: Record<string, unknown>;
};

const ERROR_STANDARD_PROPERTIES = new Set([
  "cause",
  "message",
  "name",
  "stack",
]);
const MAX_ERROR_CAUSE_DEPTH = 16;
const MAX_ERROR_PROPERTY_DEPTH = 5;

const safePropertyValue = (
  value: unknown,
  seen: Set<unknown>,
  depth = 0,
): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol")
    return String(value);
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "function")
    return `[Function ${value.name || "anonymous"}]`;
  if (depth >= MAX_ERROR_PROPERTY_DEPTH) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => safePropertyValue(item, seen, depth + 1));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      try {
        out[key] = safePropertyValue(
          (value as Record<string, unknown>)[key],
          seen,
          depth + 1,
        );
      } catch (error) {
        out[key] = `[Unserializable: ${toError(error).message}]`;
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
};

const errorProperties = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, unknown> = {};
  let propertyNames: string[];
  try {
    propertyNames = Object.getOwnPropertyNames(value);
  } catch {
    return undefined;
  }
  for (const key of propertyNames) {
    if (ERROR_STANDARD_PROPERTIES.has(key)) continue;
    try {
      out[key] = safePropertyValue(
        (value as Record<string, unknown>)[key],
        new Set([value]),
      );
    } catch (error) {
      out[key] = `[Unserializable: ${toError(error).message}]`;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const errorCause = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return (value as { cause?: unknown }).cause;
  } catch {
    return undefined;
  }
};

const captureErrorCauses = (error: Error): CapturedErrorCause[] => {
  const causes: CapturedErrorCause[] = [];
  const seen = new Set<unknown>([error]);
  let cause = errorCause(error);
  while (cause !== undefined && causes.length < MAX_ERROR_CAUSE_DEPTH) {
    if (seen.has(cause)) {
      causes.push({
        message: "Cause chain references an earlier error",
        name: "CircularErrorCause",
      });
      return causes;
    }
    if (typeof cause === "object" && cause !== null) seen.add(cause);
    const resolved = toError(cause);
    const captured: CapturedErrorCause = {
      message: resolved.message,
      name: resolved.name,
    };
    if (resolved.stack !== undefined) captured.stack = resolved.stack;
    const properties = errorProperties(cause);
    if (properties !== undefined) captured.properties = properties;
    causes.push(captured);
    cause = errorCause(cause);
  }
  if (cause !== undefined)
    causes.push({
      message: `Cause chain exceeded ${MAX_ERROR_CAUSE_DEPTH} levels`,
      name: "TruncatedErrorCause",
    });
  return causes;
};

const stackWithCauses = (
  stack: string | undefined,
  causes: CapturedErrorCause[],
): string | undefined => {
  if (causes.length === 0) return stack;
  const sections = causes.map(
    (cause) => `Caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`,
  );
  return [stack, ...sections].filter((part) => part !== undefined).join("\n");
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "csrftoken",
  "idtoken",
  "password",
  "passwd",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "setcookie",
  "token",
]);
const URL_KEY_NAMES = new Set([
  "endpoint",
  "errorfilename",
  "resourceurl",
  "url",
]);
const normalizeFieldName = (key: string): string =>
  key.replace(/[^a-z0-9]/gi, "").toLowerCase();
const isSensitiveField = (key: string): boolean =>
  SENSITIVE_KEY_NAMES.has(normalizeFieldName(key));
const isUrlField = (key: string): boolean =>
  URL_KEY_NAMES.has(normalizeFieldName(key));

const redactUrl = (value: string): string => {
  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
    const url = new URL(value, "https://beacon.invalid");
    url.search = "";
    url.hash = "";
    return absolute ? url.toString() : `${url.pathname}`;
  } catch {
    return value.replace(/[?#].*$/, "");
  }
};

const redactUrlsInText = (value: string): string =>
  value.replace(
    /(?:[a-z][a-z\d+.-]*:\/\/|\/)[^\s"'<>]*[?#][^\s"'<>]*/gi,
    (candidate) => redactUrl(candidate),
  );

const redactString = (value: string): string =>
  redactUrlsInText(value)
    .replace(
      /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi,
      (_match, scheme: string) => `${scheme} ${REDACTED}`,
    )
    .replace(
      /([?&](?:access_token|api_?key|authorization|code|id_token|password|refresh_token|secret|token)=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /\b((?:access_?token|api_?key|authorization|client_?secret|cookie|id_?token|password|passwd|refresh_?token|secret|token)\s*[:=]\s*)(?!Bearer\b|\[REDACTED\])[^,\s;]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      REDACTED,
    );

const redactValue = (
  value: unknown,
  key: string | undefined,
  seen: Set<object>,
  depth = 0,
): unknown => {
  if (key !== undefined && isSensitiveField(key)) return REDACTED;
  if (typeof value === "string") {
    return redactString(
      key !== undefined && isUrlField(key) ? redactUrl(value) : value,
    );
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 12) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const redacted = Array.isArray(value)
    ? value.map((entry) => redactValue(entry, undefined, seen, depth + 1))
    : Object.fromEntries(
        Object.entries(value).map(([field, entry]) => [
          field,
          redactValue(entry, field, seen, depth + 1),
        ]),
      );
  seen.delete(value);
  return redacted;
};

/** Redact an event without mutating the caller's object. */
export const redactBeaconEvent = (event: BeaconEvent): BeaconEvent => {
  const redacted: BeaconEvent = {
    ...event,
    message: redactString(event.message),
  };
  if (event.stack !== undefined) redacted.stack = redactString(event.stack);
  if (event.groupingKey !== undefined) {
    redacted.groupingKey = redactString(event.groupingKey).slice(0, 200);
  }
  if (event.tags !== undefined) {
    redacted.tags = Object.fromEntries(
      Object.entries(event.tags).map(([key, value]) => [
        key,
        redactValue(value, key, new Set()),
      ]),
    ) as BeaconTags;
  }
  if (event.extra !== undefined) {
    redacted.extra = redactValue(event.extra, undefined, new Set()) as Record<
      string,
      unknown
    >;
  }
  return redacted;
};

const CEF_SHARP_REJECTION =
  /^Object Not Found Matching Id:\d+, MethodName:[A-Za-z_$][\w$]*, ParamCount:\d+$/;

const FACEBOOK_IOS_IN_APP_BROWSER = /\[FBAN\/(?:FBIOS|MessengerForiOS);/i;
const INSTAGRAM_IOS_IN_APP_BROWSER = /\bInstagram\s+\d+(?:\.\d+){2,}\b/i;
const FACEBOOK_IOS_HOST_INJECTION = new Set([
  "Can't find variable: _AutofillCallbackHandler",
  "TypeError: undefined is not an object (evaluating 'window.webkit.messageHandlers')",
]);
const META_IOS_WEBKIT_BRIDGE_FAILURE =
  "TypeError: undefined is not an object (evaluating 'window.webkit.messageHandlers')";
const isInstagramIosBridgeInjection = (
  event: Pick<BeaconEvent, "message" | "stack">,
  userAgent: string,
) =>
  INSTAGRAM_IOS_IN_APP_BROWSER.test(userAgent) &&
  event.message === META_IOS_WEBKIT_BRIDGE_FAILURE &&
  event.stack?.includes("sendDataToNative") === true &&
  event.stack.includes("sendPageHideMessage");
const FACEBOOK_ANDROID_DETACHED_BRIDGE_MESSAGE =
  "Error invoking postMessage: Java object is gone";
const FACEBOOK_ANDROID_PERFORMANCE_LOGGER =
  "iabjs://navigation_performance_logger_android";

const browserUserAgent = (): string =>
  typeof navigator === "undefined" ? "" : navigator.userAgent;

/** Known browser-host/scanner failures that do not originate in page code. */
export const isKnownBeaconNoise = (
  event: Pick<BeaconEvent, "message" | "name" | "stack" | "tags">,
  userAgent = browserUserAgent(),
): boolean =>
  (event.name === "UnhandledRejection" &&
    CEF_SHARP_REJECTION.test(event.message)) ||
  (FACEBOOK_IOS_IN_APP_BROWSER.test(userAgent) &&
    FACEBOOK_IOS_HOST_INJECTION.has(event.message)) ||
  isInstagramIosBridgeInjection(event, userAgent) ||
  (event.name === "Error" &&
    event.message === FACEBOOK_ANDROID_DETACHED_BRIDGE_MESSAGE &&
    event.tags?.errorFilename === FACEBOOK_ANDROID_PERFORMANCE_LOGGER &&
    event.stack?.includes(FACEBOOK_ANDROID_PERFORMANCE_LOGGER) === true);

const errorWithStack = (
  name: string,
  message: string,
  location?: string,
): Error => {
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}${location ? `\n    at ${location}` : ""}`;
  return error;
};

const errorWithoutStack = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
  // Resource `error` events expose the failed element but no JavaScript call
  // stack. Keep an own undefined property instead of deleting it: Firefox can
  // expose an inherited stack after deletion, which incorrectly fingerprints
  // the Beacon collector as the resource failure's source.
  Object.defineProperty(error, "stack", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  return error;
};

const errorEventLocation = (event: ErrorEvent): string | undefined => {
  if (event.filename === "") return undefined;
  const line = event.lineno > 0 ? `:${event.lineno}` : "";
  const column = event.colno > 0 ? `:${event.colno}` : "";
  return `${event.filename}${line}${column}`;
};

const errorEventTags = (
  event: ErrorEvent,
): Record<string, string> | undefined => {
  const tags: Record<string, string> = {};
  if (event.filename !== "") tags.errorFilename = event.filename;
  if (event.lineno > 0) tags.errorLine = String(event.lineno);
  if (event.colno > 0) tags.errorColumn = String(event.colno);
  return Object.keys(tags).length > 0 ? tags : undefined;
};

const RESOURCE_ERROR_TAGS = new Set([
  "audio",
  "embed",
  "iframe",
  "image",
  "img",
  "input",
  "link",
  "object",
  "script",
  "source",
  "track",
  "video",
]);

const resourceUrlOf = (element: Element): string | undefined => {
  const currentSrc = (element as Element & { currentSrc?: unknown }).currentSrc;
  if (typeof currentSrc === "string" && currentSrc !== "") return currentSrc;
  for (const attribute of ["src", "href", "data", "srcset", "poster"]) {
    const value = element.getAttribute(attribute);
    if (value !== null && value !== "") return value;
  }
  return undefined;
};

const isCrossOriginResource = (url: string | undefined): boolean => {
  if (url === undefined) return false;
  try {
    return new URL(url, location.href).origin !== location.origin;
  } catch {
    return false;
  }
};

const resourceSourceOf = (url: string | undefined): string => {
  if (url === undefined) return "unknown source";
  try {
    const parsed = new URL(url, location.href);
    return parsed.hostname || parsed.protocol.replace(":", "");
  } catch {
    return "unknown source";
  }
};

const describeElement = (element: Element): string => {
  const tag = element.tagName.toLowerCase();
  const beaconName = element
    .getAttribute(BEACON_ATTRIBUTE.NAME)
    ?.trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, "-")
    .slice(0, 64);
  if (beaconName) return `${tag}[${beaconName}]`;
  const id = element.id ? `#${element.id}` : "";
  const cls =
    typeof element.className === "string" && element.className.trim() !== ""
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
  return `${tag}${id}${cls}`;
};

const SHORT_URL_MAX = 80;
const shortUrl = (url: string): string => {
  // Absolute URLs parse without a base — important in sandboxed frames,
  // where location.origin is the string "null" and would poison the base.
  try {
    return new URL(url).pathname;
  } catch {
    // Relative — resolve against the page below.
  }
  try {
    return new URL(url, location.origin).pathname;
  } catch {
    return url.slice(0, SHORT_URL_MAX);
  }
};

// An anchor whose click does something invisible to us (new tab / download /
// off-site nav) — so "nothing changed on this page" doesn't make it "dead".
const isInvisibleAnchor = (anchor: HTMLAnchorElement): boolean => {
  if (anchor.target === "_blank" || anchor.hasAttribute("download"))
    return true;
  try {
    return new URL(anchor.href, location.origin).origin !== location.origin;
  } catch {
    return true;
  }
};

const isModifiedAnchorClick = (event: Event): boolean =>
  event instanceof MouseEvent &&
  (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey);

// A control we'd expect to DO something when clicked (else null) — used for
// dead-click detection.
const deadClickCandidate = (target: Element, event: Event): Element | null => {
  const control = target.closest<HTMLElement>(
    "button, a[href], [role='button'], input[type='submit'], input[type='button'], [onclick]",
  );
  if (control === null) return null;
  if (
    control.getAttribute(BEACON_ATTRIBUTE.DEAD_CLICK) === "ignore" ||
    control.hasAttribute("disabled") ||
    control.getAttribute("aria-disabled") === "true" ||
    control.getAttribute("aria-pressed") === "true" ||
    control.getAttribute("aria-selected") === "true" ||
    (control.hasAttribute("aria-current") &&
      control.getAttribute("aria-current") !== "false")
  ) {
    return null;
  }
  if (
    control instanceof HTMLAnchorElement &&
    (isInvisibleAnchor(control) || isModifiedAnchorClick(event))
  ) {
    return null;
  }
  return control;
};

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const isFormControl = (element: Element): element is FormControl =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLSelectElement ||
  element instanceof HTMLTextAreaElement;

const formControlState = (control: FormControl): string => {
  if (control instanceof HTMLInputElement) {
    return `${control.value}\u0000${control.checked ? "checked" : "unchecked"}`;
  }
  if (control instanceof HTMLSelectElement) {
    return `${control.value}\u0000${Array.from(control.options)
      .map((option) => (option.selected ? "1" : "0"))
      .join("")}`;
  }
  return control.value;
};

// This snapshot exists only in memory during the click-response window. Form
// values are compared locally and are never included in Beacon telemetry.
const snapshotOwningForm = (
  control: Element,
): Map<FormControl, string> | null => {
  const nearest = control.closest("form");
  const associated =
    control instanceof HTMLButtonElement || control instanceof HTMLInputElement
      ? control.form
      : null;
  const form = nearest ?? associated;
  if (form === null) return null;
  const snapshot = new Map<FormControl, string>();
  for (const element of Array.from(form.elements)) {
    if (isFormControl(element)) {
      snapshot.set(element, formControlState(element));
    }
  }
  return snapshot;
};

const formStateChanged = (
  snapshot: Map<FormControl, string> | null,
): boolean => {
  if (snapshot === null) return false;
  for (const [control, state] of snapshot) {
    if (!control.isConnected || formControlState(control) !== state)
      return true;
  }
  return false;
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
      if (reported || count === 0) return;
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
    // pagehide is terminal — flush unconditionally; visibilitychange only when
    // the page is actually hidden (matches the web-vitals reporting pattern).
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
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
  const redact = options.redact !== false;
  const filterKnownNoise = options.filterKnownNoise !== false;
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
  const NAVIGATION_RESPONSE_DEFAULT_MS = 8000;
  const LAYOUT_OVERFLOW_SETTLE_DEFAULT_MS = 600;
  const LAYOUT_OVERFLOW_MAX_REPORTS_DEFAULT = 5;
  const LAYOUT_OVERFLOW_VIEWPORT_TOLERANCE_PX = 2;
  const LAYOUT_OVERFLOW_CONTAINER_TOLERANCE_PX = 4;
  const VIEWPORT_BUCKET_SM_PX = 480;
  const VIEWPORT_BUCKET_MD_PX = 768;
  const VIEWPORT_BUCKET_LG_PX = 1024;
  const VIEWPORT_BUCKET_XL_PX = 1440;
  const OCCLUSION_SAMPLE_LIMIT = 25;
  const OCCLUSION_COVERAGE_MIN = 0.9;
  const INVISIBLE_TEXT_SAMPLE_LIMIT = 40;
  const INVISIBLE_TEXT_CONTRAST_MAX = 1.2;
  const STUCK_LOADING_DEFAULT_MS = 20000;
  const STUCK_LOADING_POLL_MS = 5000;
  const SCROLL_JAIL_EVENT_COUNT = 8;
  const SCROLL_JAIL_WINDOW_MS = 2000;
  const SCROLL_JAIL_BOUNDARY_TOLERANCE_PX = 2;
  const REQUEST_STORM_DEFAULT_COUNT = 15;
  const REQUEST_STORM_DEFAULT_WINDOW_MS = 10000;
  const SOCKET_FLAP_CYCLES = 4;
  const SOCKET_FLAP_WINDOW_MS = 60000;
  const STALLED_STREAM_DEFAULT_MS = 60000;
  const RELOAD_LOOP_COUNT = 4;
  const RELOAD_LOOP_WINDOW_MS = 60000;
  const RELOAD_LOOP_STORAGE_KEY = "beacon:reload-times";
  const STALE_RELEASE_STORAGE_KEY = "beacon:release-first-seen";
  const STALE_RELEASE_GRACE_MS = 600000;
  const STALE_RELEASE_HISTORY_LIMIT = 5;
  const FORM_FRUSTRATION_THRESHOLD = 3;
  const FORM_FRUSTRATION_WINDOW_MS = 60000;
  const FORM_INVALID_BURST_GAP_MS = 100;
  const SIGNAL_TEXT_MAX = 180;
  const slowResponseMs = signals?.slowResponseMs ?? SLOW_RESPONSE_DEFAULT_MS;
  const navigationResponseMs = Math.max(
    DEAD_CLICK_WINDOW_MS,
    signals?.navigationResponseMs ?? NAVIGATION_RESPONSE_DEFAULT_MS,
  );
  const rageCount = signals?.rageClickCount ?? RAGE_COUNT_DEFAULT;
  // Exact counters avoid millisecond timestamp ties when a click synchronously
  // starts a request or opens another browsing context.
  let networkRequestCount = 0;
  let externalNavigationCount = 0;
  let inSignalConsole = false;
  let pageLifecycleEnding = false;
  // Set by the settled-scan watchdogs so SPA navigations recorded by the
  // history instrumentation also schedule a post-settle scan.
  let overflowScanOnNavigation: (() => void) | null = null;
  // Set by the request-storm watchdog; called by the fetch/XHR wrappers.
  let recordRequestForStorm: ((url: string, method: string) => void) | null =
    null;

  // True while an intentional overlay owns the page — an open dialog, or a
  // fixed element covering (nearly) the whole viewport, the scrim pattern
  // drawers and modals use even without dialog ARIA. Watchdogs that would
  // misread "the page is covered / locked on purpose" as a bug stand down.
  const OVERLAY_VIEWPORT_COVERAGE_MIN = 0.9;
  const viewportCoveredByOverlay = (): boolean => {
    if (typeof document === "undefined") return false;
    if (document.querySelector('[aria-modal="true"], dialog[open]') !== null) {
      return true;
    }
    if (typeof document.elementFromPoint !== "function") return false;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    if (viewportWidth === 0 || viewportHeight === 0) return false;
    let node = document.elementFromPoint(viewportWidth / 2, viewportHeight / 2);
    while (node !== null) {
      const style = window.getComputedStyle(node);
      if (style.position === "fixed") {
        const rect = node.getBoundingClientRect();
        const coverage =
          (rect.width * rect.height) / (viewportWidth * viewportHeight);
        if (coverage >= OVERLAY_VIEWPORT_COVERAGE_MIN) return true;
      }
      node = node.parentElement;
    }

    return false;
  };

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
      const replayId = options.getReplayId?.();
      const traceId = options.getTraceId?.();
      const vital: WebVital = {
        at: Date.now(),
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
        id: metric.id,
        name: metric.name,
        navigationType: metric.navigationType,
        path: location.pathname,
        project: options.project,
        rating:
          metric.rating === "good" ||
          metric.rating === "needs-improvement" ||
          metric.rating === "poor"
            ? metric.rating
            : "needs-improvement",
        ...(options.release === undefined ? {} : { release: options.release }),
        ...(replayId === undefined ? {} : { replayId }),
        samplingRate: vitalsOptions.samplingRate ?? 1,
        schemaVersion: vitalsOptions.schemaVersion ?? 1,
        ...(vitalsOptions.sdkVersion === undefined
          ? {}
          : { sdkVersion: vitalsOptions.sdkVersion }),
        ...(traceId === undefined ? {} : { traceId }),
        value: metric.value,
      };
      vitalsOptions.onVital?.(vital);
      if (vitalsOptions.transport !== undefined) {
        void Promise.resolve(vitalsOptions.transport(vital)).catch(() => {
          // best-effort telemetry
        });
        return;
      }
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
      typeof PerformanceNavigationTiming !== "undefined" &&
      navigationEntry instanceof PerformanceNavigationTiming
        ? navigationEntry.type
        : "navigate";
    observeLongTasks(reportVital, navigationType);
  }

  const buffer: BeaconEvent[] = [];
  const breadcrumbs: Breadcrumb[] = [];
  const cleanups: Array<() => void> = [];
  const pendingClickCleanups = new Set<() => void>();
  cleanups.push(() => {
    for (const cleanup of pendingClickCleanups) cleanup();
    pendingClickCleanups.clear();
  });
  let flushPendingNetworkFailures = (): void => {};
  let tags: BeaconTags = {};
  let user: { id?: string; email?: string } | undefined;

  const flush = async (useBeacon = false): Promise<void> => {
    flushPendingNetworkFailures();
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
    const customized =
      options.beforeSend !== undefined
        ? options.beforeSend(enriched)
        : enriched;
    return customized === null || !redact
      ? customized
      : redactBeaconEvent(customized);
  };

  const push = (event: BeaconEvent): void => {
    if (filterKnownNoise && isKnownBeaconNoise(event)) return;
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
    const errorCauses = captureErrorCauses(resolved);
    const event: BeaconEvent = {
      level: context.level ?? "error",
      message: resolved.message,
      name: resolved.name,
    };
    if (context.groupingKey !== undefined) {
      event.groupingKey = context.groupingKey;
    }
    const stack = stackWithCauses(resolved.stack, errorCauses);
    if (stack !== undefined) event.stack = stack;
    if (context.traceId !== undefined) event.traceId = context.traceId;
    if (context.spanId !== undefined) event.spanId = context.spanId;
    if (context.tags !== undefined) event.tags = context.tags;
    if (context.extra !== undefined || errorCauses.length > 0)
      event.extra = {
        ...context.extra,
        ...(errorCauses.length > 0 ? { errorCauses } : {}),
      };
    push(event);
  };

  const captureMessage: Beacon["captureMessage"] = (
    message,
    level = "info",
    context = {},
  ) => {
    const event: BeaconEvent = { level, message, name: "Message" };
    if (context.groupingKey !== undefined) {
      event.groupingKey = context.groupingKey;
    }
    if (context.traceId !== undefined) event.traceId = context.traceId;
    if (context.spanId !== undefined) event.spanId = context.spanId;
    if (context.tags !== undefined) event.tags = context.tags;
    if (context.extra !== undefined) event.extra = context.extra;
    push(event);
  };

  // A signal is a warning-level capture with a stable message (so the store
  // groups it) and the variable detail in tags.
  const emitSignal = (
    message: string,
    signalTags: BeaconTags & { signal: BeaconSignal },
    traceId?: string,
    extra?: Record<string, unknown>,
    stackBoundary?: CallableFunction,
    fallbackFramesToDrop = 1,
  ): void => {
    const error = new Error(message);
    const captureStackTrace = (
      Error as ErrorConstructor & {
        captureStackTrace?: (
          target: object,
          constructor?: CallableFunction,
        ) => void;
      }
    ).captureStackTrace;
    if (captureStackTrace !== undefined) {
      captureStackTrace(error, stackBoundary ?? emitSignal);
    } else if (error.stack !== undefined) {
      let remaining = fallbackFramesToDrop;
      error.stack = error.stack
        .split("\n")
        .filter((line) => {
          const isFrame =
            /^\s*at\b/u.test(line) || /@.+:\d+:\d+\s*$/u.test(line);
          if (!isFrame || remaining === 0) return true;
          remaining -= 1;

          return false;
        })
        .join("\n");
    }
    captureException(error, {
      level: "warning",
      tags: signalTags,
      ...(traceId !== undefined ? { traceId } : {}),
      ...(extra !== undefined ? { extra } : {}),
    });
  };

  const responseTraceId = (value: string | null): string | undefined => {
    const traceId = value?.trim().toLowerCase();

    return traceId !== undefined && /^[0-9a-f]{32}$/.test(traceId)
      ? traceId
      : undefined;
  };

  const reportResponseSignal = (
    url: string,
    method: string,
    status: number,
    durationMs: number,
    traceId?: string,
  ): void => {
    if (signals === null) return;
    const responseEndpoint = shortUrl(url);
    const responseMethod = method.toUpperCase();
    if (signals.serverErrors !== false && status >= 500) {
      emitSignal(
        `Server error response (5xx) — ${responseMethod} ${responseEndpoint}`,
        {
          endpoint: responseEndpoint,
          method: responseMethod,
          signal: BEACON_SIGNAL.HTTP_5XX,
          status: String(status),
        },
        traceId,
      );
      return;
    }
    if (signals.slowResponses !== false && durationMs > slowResponseMs) {
      emitSignal(
        `Slow response — ${responseMethod} ${responseEndpoint}`,
        {
          durationMs: String(durationMs),
          endpoint: responseEndpoint,
          method: responseMethod,
          signal: BEACON_SIGNAL.SLOW_RESPONSE,
        },
        traceId,
      );
    }
  };

  type NetworkFailureKind = "offline" | "timeout" | "transport";
  const NETWORK_FAILURE_BURST_MS = 100;
  const SUSPENDED_BACKGROUND_FAILURE_MS = 30_000;
  const pendingNetworkFailures = new Map<
    NetworkFailureKind,
    BeaconNetworkFailure[]
  >();
  let networkFailureTimer: number | undefined;

  const networkState = () => {
    const online: boolean | null =
      typeof navigator.onLine === "boolean" ? navigator.onLine : null;

    return {
      online,
      visibilityState:
        typeof document.visibilityState === "string"
          ? document.visibilityState
          : "unknown",
    };
  };

  const failureKind = (error: Error): NetworkFailureKind | "aborted" => {
    if (error.name === "AbortError") return "aborted";
    if (error.name === "TimeoutError") return "timeout";
    if (typeof navigator.onLine === "boolean" && !navigator.onLine)
      return "offline";
    return "transport";
  };

  const failureMessage = (
    kind: NetworkFailureKind,
    failures: BeaconNetworkFailure[],
    endpoints: string[],
  ): string => {
    if (kind === "offline") return "Browser offline — network requests failed";
    if (endpoints.length > 1) return "Network connectivity interruption";
    const failure = failures[0]!;
    if (kind === "timeout")
      return `Network request timed out — ${failure.method} ${failure.endpoint}`;
    return `Network request failed — ${failure.method} ${failure.endpoint}`;
  };

  const flushNetworkFailures = (): void => {
    if (networkFailureTimer !== undefined) {
      window.clearTimeout(networkFailureTimer);
      networkFailureTimer = undefined;
    }
    const groups = [...pendingNetworkFailures.entries()];
    pendingNetworkFailures.clear();
    for (const [kind, failures] of groups) {
      const newestFailureAt = Math.max(...failures.map(({ at }) => at));
      const reportDelayMs = Math.max(0, Date.now() - newestFailureAt);
      const endpoints = [...new Set(failures.map(({ endpoint }) => endpoint))];
      const methods = [...new Set(failures.map(({ method }) => method))];
      const onlineStates = [
        ...new Set(failures.map(({ online }) => String(online))),
      ];
      const transports = [
        ...new Set(failures.map(({ transport }) => transport)),
      ];
      const visibilityStates = [
        ...new Set(failures.map(({ visibilityState }) => visibilityState)),
      ];
      const suspendedBackgroundTransport =
        kind === "transport" &&
        failures.every(({ visibilityState }) => visibilityState === "hidden") &&
        reportDelayMs >= SUSPENDED_BACKGROUND_FAILURE_MS;
      if (suspendedBackgroundTransport) {
        addBreadcrumb({
          data: {
            attemptCount: failures.length,
            endpoints,
            reportDelayMs,
          },
          message: "Suppressed stale background network interruption",
          type: "fetch",
        });
        continue;
      }
      emitSignal(
        failureMessage(kind, failures, endpoints),
        {
          attemptCount: String(failures.length),
          endpointCount: String(endpoints.length),
          endpoints: endpoints.join(","),
          failureKind: kind,
          method: methods.length === 1 ? methods[0]! : "multiple",
          online: onlineStates.length === 1 ? onlineStates[0]! : "mixed",
          reportDelayMs: String(reportDelayMs),
          signal: BEACON_SIGNAL.FETCH_FAILED,
          transport: transports.length === 1 ? transports[0]! : "multiple",
          visibilityState:
            visibilityStates.length === 1 ? visibilityStates[0]! : "mixed",
          ...(endpoints.length === 1 ? { endpoint: endpoints[0]! } : {}),
        },
        undefined,
        { networkFailures: failures },
      );
    }
  };
  flushPendingNetworkFailures = flushNetworkFailures;

  const reportFailureSignal = (
    url: string,
    method: string,
    durationMs: number,
    transportKind: BeaconNetworkFailure["transport"],
    errorValue: unknown,
  ): void => {
    if (signals === null || signals.failedRequests === false) return;
    const error = toError(errorValue);
    const kind = failureKind(error);
    // Request cancellation is an expected browser/application lifecycle event.
    // It remains a breadcrumb but must not create an issue.
    if (kind === "aborted" || (kind === "transport" && pageLifecycleEnding))
      return;
    const properties = errorProperties(error);
    const state = networkState();
    const failure: BeaconNetworkFailure = {
      at: Date.now(),
      durationMs,
      endpoint: shortUrl(url),
      error: {
        message: error.message,
        name: error.name,
        ...(properties !== undefined ? { properties } : {}),
        ...(error.stack !== undefined ? { stack: error.stack } : {}),
      },
      method: method.toUpperCase(),
      online: state.online,
      transport: transportKind,
      visibilityState: state.visibilityState,
    };
    const pending = pendingNetworkFailures.get(kind);
    if (pending === undefined) pendingNetworkFailures.set(kind, [failure]);
    else pending.push(failure);
    if (networkFailureTimer === undefined) {
      networkFailureTimer = window.setTimeout(
        flushNetworkFailures,
        NETWORK_FAILURE_BURST_MS,
      );
    }
  };

  // Observe whether a control click produces a visible or asynchronous response.
  // Dead- and rage-click detection share this so they cannot disagree about
  // whether the page responded.
  const observeClickResponse = (
    control: Element,
    event: Event,
    report: (responded: boolean) => void,
  ): void => {
    const urlBefore = location.href;
    const scrollBefore = window.scrollY;
    const activeBefore = document.activeElement;
    const formBefore = snapshotOwningForm(control);
    const networkRequestsBefore = networkRequestCount;
    const externalNavigationsBefore = externalNavigationCount;
    let routerAcceptedNavigation = false;
    let mutated = false;
    let extended = false;
    let finished = false;
    let timer: number | undefined;
    const observeRouterAcceptance = (handledEvent: Event): void => {
      if (handledEvent !== event) return;
      routerAcceptedNavigation =
        control instanceof HTMLAnchorElement && handledEvent.defaultPrevented;
    };
    const responded = (): boolean =>
      mutated ||
      formStateChanged(formBefore) ||
      location.href !== urlBefore ||
      window.scrollY !== scrollBefore ||
      document.activeElement !== activeBefore ||
      networkRequestCount !== networkRequestsBefore ||
      externalNavigationCount !== externalNavigationsBefore;
    const finish = (didRespond: boolean): void => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      control.removeEventListener("click", observeRouterAcceptance);
      if (timer !== undefined) window.clearTimeout(timer);
      pendingClickCleanups.delete(cancel);
      report(didRespond);
    };
    const cancel = (): void => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      control.removeEventListener("click", observeRouterAcceptance);
      if (timer !== undefined) window.clearTimeout(timer);
    };
    const observer = new MutationObserver(() => {
      mutated = true;
      if (extended) finish(true);
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    pendingClickCleanups.add(cancel);
    // The document listener runs in capture phase, before an SPA router's
    // target listener calls preventDefault(). A one-shot target listener added
    // here runs later in the same dispatch and observes that acceptance without
    // relying on microtask timing (which differs across DOM implementations).
    control.addEventListener("click", observeRouterAcceptance, { once: true });
    timer = window.setTimeout(() => {
      if (responded()) {
        finish(true);
        return;
      }
      if (!routerAcceptedNavigation) {
        finish(false);
        return;
      }
      // Vue Router and similar SPA routers prevent the anchor's native default
      // before awaiting a lazy route module. That is an acknowledged click,
      // but it is not proof the route will ever settle: keep observing until
      // the navigation-specific deadline so genuine stalled routers still
      // surface without misclassifying an in-flight dynamic import as dead.
      extended = true;
      timer = window.setTimeout(
        () => finish(responded()),
        navigationResponseMs - DEAD_CLICK_WINDOW_MS,
      );
    }, DEAD_CLICK_WINDOW_MS);
  };

  // The route + stable control descriptor belongs in the message because
  // @absolutejs/errors fingerprints browser events from name/message/stack.
  // Keeping it only in tags would collapse unrelated controls into one issue.
  const clickSignalMessage = (message: string, control: Element): string =>
    `${message} — ${shortUrl(location.href)} — ${describeElement(control)}`;

  // --- auto-instrumentation -------------------------------------------------

  if (instrument.globalErrors !== false) {
    const onError = (event: Event): void => {
      if (event instanceof ErrorEvent) {
        const location = errorEventLocation(event);
        const error =
          event.error !== undefined && event.error !== null
            ? toError(event.error)
            : errorWithStack(
                "Error",
                event.message || "Uncaught error",
                location,
              );
        captureException(error, {
          level: "error",
          tags: errorEventTags(event),
        });
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const resourceType = target.tagName.toLowerCase();
      if (!RESOURCE_ERROR_TAGS.has(resourceType)) return;
      const resourceUrl = resourceUrlOf(target);
      const failure: BeaconResourceFailure = {
        crossOrigin: isCrossOriginResource(resourceUrl),
        target: describeElement(target),
        type: resourceType,
        ...(resourceUrl === undefined ? {} : { url: resourceUrl }),
      };
      const resourceErrors = instrument.resourceErrors;
      const resourceLevel =
        typeof resourceErrors === "function"
          ? resourceErrors(failure)
          : resourceErrors === false
            ? false
            : "error";
      if (resourceLevel === false) return;
      const warning = resourceLevel === "warning";
      // Warning titles deliberately omit the full URL. The URL remains in tags,
      // while the stable provider-level message groups an image grid's many
      // failed URLs into one issue instead of one issue per asset.
      const message = warning
        ? `Failed to load ${resourceType} resource from ${resourceSourceOf(resourceUrl)}`
        : `Failed to load ${resourceType} resource${
            resourceUrl === undefined ? "" : `: ${resourceUrl}`
          }`;
      captureException(
        errorWithoutStack(
          warning ? "ResourceLoadWarning" : "ResourceLoadError",
          message,
        ),
        {
          level: resourceLevel,
          tags: {
            resourceTarget: failure.target,
            resourceType,
            ...(resourceUrl === undefined ? {} : { resourceUrl }),
          },
        },
      );
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
      if (
        typeof reason === "object" &&
        reason !== null &&
        typeof (reason as { stack?: unknown }).stack === "string"
      ) {
        captureException(reason, { level: "error" });
        return;
      }
      const message =
        typeof reason === "string" ? reason : safeStringify(reason);
      captureException(errorWithoutStack("UnhandledRejection", message), {
        extra: {
          rejectionType:
            reason === null
              ? "null"
              : Array.isArray(reason)
                ? "array"
                : typeof reason,
        },
        level: "error",
      });
    };
    window.addEventListener("unhandledrejection", onRejection);
    cleanups.push(() =>
      window.removeEventListener("unhandledrejection", onRejection),
    );
  }

  if (instrument.console !== false && typeof console !== "undefined") {
    for (const method of ["error", "warn"] as const) {
      const original = console[method];
      const wrappedConsole = (...args: unknown[]): void => {
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
          const text = args
            .map(String)
            .join(" ")
            .trim()
            .slice(0, SIGNAL_TEXT_MAX);
          if (text !== "")
            emitSignal(
              text,
              { signal: BEACON_SIGNAL.CONSOLE_ERROR },
              undefined,
              undefined,
              wrappedConsole,
              2,
            );
          inSignalConsole = false;
        }
        original.apply(console, args);
      };
      console[method] = wrappedConsole;
      cleanups.push(() => {
        console[method] = original;
      });
    }
  }

  if (instrument.clicks !== false && typeof document !== "undefined") {
    if (signals !== null) {
      const originalWindowOpen = window.open;
      const wrappedWindowOpen = ((
        ...args: Parameters<typeof window.open>
      ): ReturnType<typeof window.open> => {
        externalNavigationCount += 1;

        return originalWindowOpen.apply(window, args);
      }) as typeof window.open;
      window.open = wrappedWindowOpen;
      cleanups.push(() => {
        if (window.open === wrappedWindowOpen) window.open = originalWindowOpen;
      });
    }

    let unresponsiveClicks: Array<{
      at: number;
      control: Element;
      x: number;
      y: number;
    }> = [];
    const onClick = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      addBreadcrumb({ message: describeElement(target), type: "click" });
      if (signals === null) return;
      const control = deadClickCandidate(target, event);
      if (control === null) return;
      const detectRage =
        signals.rageClicks !== false && event instanceof MouseEvent;
      const detectDead = signals.deadClicks !== false;
      if (!detectRage && !detectDead) return;
      const clickedAt = Date.now();
      const x = event instanceof MouseEvent ? event.clientX : 0;
      const y = event instanceof MouseEvent ? event.clientY : 0;
      observeClickResponse(control, event, (responded) => {
        if (responded) {
          // A response between repeated clicks breaks the rage sequence.
          unresponsiveClicks = unresponsiveClicks.filter(
            (click) => click.control !== control,
          );
          return;
        }
        if (detectDead) {
          emitSignal(
            clickSignalMessage("Dead click — control didn't respond", control),
            {
              signal: BEACON_SIGNAL.DEAD_CLICK,
              target: describeElement(control),
            },
          );
        }
        if (detectRage) {
          unresponsiveClicks = unresponsiveClicks.filter(
            (click) =>
              click.control === control &&
              clickedAt - click.at < RAGE_WINDOW_MS &&
              Math.abs(x - click.x) < RAGE_RADIUS_PX &&
              Math.abs(y - click.y) < RAGE_RADIUS_PX,
          );
          unresponsiveClicks.push({ at: clickedAt, control, x, y });
          if (unresponsiveClicks.length < rageCount) return;
          unresponsiveClicks = [];
          emitSignal(
            clickSignalMessage(
              "Rage click — repeated clicks with no response",
              control,
            ),
            {
              signal: BEACON_SIGNAL.RAGE_CLICK,
              target: describeElement(control),
            },
          );
        }
      });
    };
    document.addEventListener("click", onClick, true);
    cleanups.push(() => document.removeEventListener("click", onClick, true));
  }

  // ——— Settled-scan watchdogs ———————————————————————————————————————————
  // Once layout settles (first load, resize end, SPA navigation), one pass
  // over the visible DOM runs the visual detectors:
  //   layout overflow — elements that break their bounds. Three kinds:
  //     viewport  — an in-flow element crosses the viewport's horizontal
  //                 edges (a control pushed offscreen at an untested width);
  //     container — an in-flow child paints past its parent's border box
  //                 while the parent neither scrolls nor clips;
  //     clipped   — content cut by overflow hidden/clip without ellipsis.
  //   occluded controls — an interactive control whose center is covered by
  //     an unrelated element (leaked scrims, z-index bugs). Skipped while a
  //     dialog is open, because covering the page is then intentional.
  //   invisible text — sampled headings/controls whose text color composites
  //     to (nearly) the same color as their opaque background — the classic
  //     theme-token bug. Gradients/images and translucent stacks are skipped.
  //   stuck loading — `aria-busy`/`role="progressbar"` indicators still
  //     visible after `stuckLoadingMs` (checked on a slow poll as well, so a
  //     spinner that never resolves is caught without any user action).
  // Shared discipline: spill/measure values live in tags, never in messages,
  // so occurrences group into one issue per element, kind, and viewport
  // bucket; reports are deduped and capped per page load; subtrees under
  // `data-beacon-overflow="allow"` (overflow) or `data-beacon-scan="allow"`
  // (the rest) are exempt.
  if (
    signals !== null &&
    typeof document !== "undefined" &&
    typeof window.getComputedStyle === "function"
  ) {
    const detectOverflow = signals.layoutOverflows !== false;
    const detectOcclusion = signals.occludedControls !== false;
    const detectInvisibleText = signals.invisibleText !== false;
    const detectStuckLoading = signals.stuckLoading !== false;
    const overflowSettleMs =
      signals.layoutOverflowSettleMs ?? LAYOUT_OVERFLOW_SETTLE_DEFAULT_MS;
    const overflowMaxReports =
      signals.layoutOverflowMaxReports ?? LAYOUT_OVERFLOW_MAX_REPORTS_DEFAULT;
    const stuckLoadingMs = signals.stuckLoadingMs ?? STUCK_LOADING_DEFAULT_MS;
    const seenOverflows = new Set<string>();
    let overflowReports = 0;
    let overflowTimer: ReturnType<typeof setTimeout> | undefined;

    const viewportBucket = (): string => {
      const width = document.documentElement.clientWidth;
      if (width < VIEWPORT_BUCKET_SM_PX) return "xs";
      if (width < VIEWPORT_BUCKET_MD_PX) return "sm";
      if (width < VIEWPORT_BUCKET_LG_PX) return "md";
      if (width < VIEWPORT_BUCKET_XL_PX) return "lg";

      return "xl";
    };

    const isScanExempt = (element: Element): boolean =>
      element.closest(`[${BEACON_ATTRIBUTE.SCAN}="allow"]`) !== null;

    // Shared reporter for the non-overflow scan detectors: same dedupe key
    // shape and per-load cap discipline as layout overflow.
    const seenScanIssues = new Set<string>();
    let scanIssueReports = 0;
    const SCAN_ISSUE_MAX_REPORTS = 10;
    const reportScanIssue = (
      element: Element,
      signal: BeaconSignal,
      detail: string,
      extraTags: Record<string, string>,
    ): void => {
      const bucket = viewportBucket();
      const key = `${signal}:${describeElement(element)}@${bucket}`;
      if (seenScanIssues.has(key)) return;
      if (scanIssueReports >= SCAN_ISSUE_MAX_REPORTS) return;
      seenScanIssues.add(key);
      scanIssueReports += 1;
      emitSignal(`${detail} — ${shortUrl(location.href)} [${bucket}]`, {
        ...extraTags,
        signal,
        target: describeElement(element),
        viewportBucket: bucket,
        viewportWidth: String(document.documentElement.clientWidth),
      });
    };

    const reportOverflow = (
      element: Element,
      kind: "clipped" | "container" | "viewport",
      detail: string,
      spillPx: number,
    ): void => {
      const bucket = viewportBucket();
      const key = `${kind}:${describeElement(element)}@${bucket}`;
      if (seenOverflows.has(key)) return;
      seenOverflows.add(key);
      overflowReports += 1;
      emitSignal(
        `Layout overflow — ${describeElement(element)} ${detail} — ${shortUrl(location.href)} [${bucket}]`,
        {
          overflowKind: kind,
          signal: BEACON_SIGNAL.LAYOUT_OVERFLOW,
          spillPx: String(Math.round(spillPx)),
          target: describeElement(element),
          viewportBucket: bucket,
          viewportWidth: String(document.documentElement.clientWidth),
        },
      );
    };

    const scanForOverflow = (): void => {
      const body = document.body;
      if (body == null || overflowReports >= overflowMaxReports) return;
      const viewportRight = document.documentElement.clientWidth;

      const visit = (element: Element, parentRect: DOMRect | null): void => {
        if (overflowReports >= overflowMaxReports) return;
        if (element.getAttribute(BEACON_ATTRIBUTE.OVERFLOW) === "allow") return;
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const inFlow =
          style.position !== "absolute" && style.position !== "fixed";

        if (inFlow) {
          // Every visited element has only visible-overflow ancestors (the
          // walk stops at scrollers and clippers), so a rect crossing the
          // viewport's horizontal edge is genuinely painted offscreen.
          const viewportSpill = Math.max(
            rect.right - viewportRight,
            -rect.left,
          );
          if (viewportSpill > LAYOUT_OVERFLOW_VIEWPORT_TOLERANCE_PX) {
            reportOverflow(
              element,
              "viewport",
              "spills past the viewport edge",
              viewportSpill,
            );

            // One issue per subtree — descendants spill by implication.
            return;
          }
          if (parentRect !== null) {
            const containerSpill = Math.max(
              rect.right - parentRect.right,
              parentRect.left - rect.left,
            );
            if (containerSpill > LAYOUT_OVERFLOW_CONTAINER_TOLERANCE_PX) {
              reportOverflow(
                element,
                "container",
                "paints outside its parent",
                containerSpill,
              );

              return;
            }
          }
        }

        const overflowX = style.overflowX;
        if (overflowX === "auto" || overflowX === "scroll") return;
        if (overflowX === "hidden" || overflowX === "clip") {
          const clipPx = element.scrollWidth - element.clientWidth;
          if (
            clipPx > LAYOUT_OVERFLOW_CONTAINER_TOLERANCE_PX &&
            style.textOverflow !== "ellipsis"
          ) {
            reportOverflow(
              element,
              "clipped",
              "content is cut by overflow hidden",
              clipPx,
            );
          }

          return;
        }

        for (const child of Array.from(element.children)) {
          visit(child, rect);
        }
      };

      visit(body, null);
    };

    const scanForOcclusion = (): void => {
      if (typeof document.elementFromPoint !== "function") return;
      // While an overlay owns the page, covering the rest of it is the point.
      if (viewportCoveredByOverlay()) return;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const controls = document.querySelectorAll(
        'a[href], button, input, select, textarea, [role="button"]',
      );
      let sampled = 0;
      for (const control of Array.from(controls)) {
        if (sampled >= OCCLUSION_SAMPLE_LIMIT) return;
        if (isScanExempt(control)) continue;
        const rect = control.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Partially offscreen controls are the layout-overflow detector's job.
        if (
          rect.left < 0 ||
          rect.top < 0 ||
          rect.right > viewportWidth ||
          rect.bottom > viewportHeight
        ) {
          continue;
        }
        sampled += 1;
        const top = document.elementFromPoint(
          (rect.left + rect.right) / 2,
          (rect.top + rect.bottom) / 2,
        );
        if (
          top === null ||
          top === control ||
          control.contains(top) ||
          top.contains(control)
        ) {
          continue;
        }
        const topRect = top.getBoundingClientRect();
        const overlapX =
          Math.min(rect.right, topRect.right) -
          Math.max(rect.left, topRect.left);
        const overlapY =
          Math.min(rect.bottom, topRect.bottom) -
          Math.max(rect.top, topRect.top);
        const coverage =
          (Math.max(overlapX, 0) * Math.max(overlapY, 0)) /
          (rect.width * rect.height);
        if (coverage < OCCLUSION_COVERAGE_MIN) continue;
        reportScanIssue(
          control,
          BEACON_SIGNAL.OCCLUDED_CONTROL,
          `Occluded control — ${describeElement(control)} is covered by ${describeElement(top)}`,
          { coveredBy: describeElement(top) },
        );
      }
    };

    // — invisible text: WCAG relative-luminance math over composited
    //   backgrounds; anything we cannot be sure about (gradients, images,
    //   never-opaque stacks, unparsable colors) is skipped, not guessed.
    const parseColor = (
      value: string,
    ): { r: number; g: number; b: number; a: number } | null => {
      const match =
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/u.exec(
          value,
        );
      if (match === null) return null;

      return {
        a: match[4] === undefined ? 1 : Number(match[4]),
        b: Number(match[3]),
        g: Number(match[2]),
        r: Number(match[1]),
      };
    };
    const channelLuminance = (channel: number): number => {
      const scaled = channel / 255;

      return scaled <= 0.03928
        ? scaled / 12.92
        : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    const relativeLuminance = (color: {
      r: number;
      g: number;
      b: number;
    }): number =>
      0.2126 * channelLuminance(color.r) +
      0.7152 * channelLuminance(color.g) +
      0.0722 * channelLuminance(color.b);
    const compositeOver = (
      top: { r: number; g: number; b: number; a: number },
      bottom: { r: number; g: number; b: number; a: number },
    ): { r: number; g: number; b: number; a: number } => {
      const alpha = top.a + bottom.a * (1 - top.a);
      if (alpha === 0) return { a: 0, b: 0, g: 0, r: 0 };
      const blend = (topChannel: number, bottomChannel: number): number =>
        (topChannel * top.a + bottomChannel * bottom.a * (1 - top.a)) / alpha;

      return {
        a: alpha,
        b: blend(top.b, bottom.b),
        g: blend(top.g, bottom.g),
        r: blend(top.r, bottom.r),
      };
    };
    const effectiveBackground = (
      element: Element,
    ): { r: number; g: number; b: number } | null => {
      let accumulated: {
        r: number;
        g: number;
        b: number;
        a: number;
      } | null = null;
      let node: Element | null = element;
      while (node !== null) {
        const style = window.getComputedStyle(node);
        if (style.backgroundImage !== "none" && style.backgroundImage !== "") {
          return null;
        }
        const background = parseColor(style.backgroundColor);
        if (background !== null && background.a > 0) {
          accumulated =
            accumulated === null
              ? background
              : compositeOver(accumulated, background);
          if (accumulated.a >= 0.999) return accumulated;
        }
        node = node.parentElement;
      }

      return null;
    };
    const scanForInvisibleText = (): void => {
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const candidates = document.querySelectorAll(
        'h1, h2, h3, button, a[href], label, [role="button"]',
      );
      let sampled = 0;
      for (const element of Array.from(candidates)) {
        if (sampled >= INVISIBLE_TEXT_SAMPLE_LIMIT) return;
        if (isScanExempt(element)) continue;
        if ((element.textContent ?? "").trim() === "") continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (
          rect.bottom < 0 ||
          rect.top > viewportHeight ||
          rect.right < 0 ||
          rect.left > viewportWidth
        ) {
          continue;
        }
        const style = window.getComputedStyle(element);
        // Transitions legitimately pass through opacity 0.
        if (Number(style.opacity || "1") < 0.1) continue;
        const foreground = parseColor(style.color);
        if (foreground === null) continue;
        sampled += 1;
        const background = effectiveBackground(element);
        if (background === null) continue;
        const transparentText = foreground.a < 0.05;
        const contrast = ((): number => {
          const fgLuminance = relativeLuminance(foreground);
          const bgLuminance = relativeLuminance(background);
          const lighter = Math.max(fgLuminance, bgLuminance);
          const darker = Math.min(fgLuminance, bgLuminance);

          return (lighter + 0.05) / (darker + 0.05);
        })();
        if (!transparentText && contrast > INVISIBLE_TEXT_CONTRAST_MAX) {
          continue;
        }
        reportScanIssue(
          element,
          BEACON_SIGNAL.INVISIBLE_TEXT,
          `Invisible text — ${describeElement(element)} renders (nearly) the same color as its background`,
          {
            background: `rgb(${Math.round(background.r)},${Math.round(background.g)},${Math.round(background.b)})`,
            contrast: contrast.toFixed(2),
            foreground: style.color,
          },
        );
      }
    };

    // — stuck loading: first-seen timestamps survive across scans; a slow
    //   poll catches spinners that hang while the user does nothing at all.
    const loadingFirstSeen = new WeakMap<Element, number>();
    const reportedStuckLoading = new WeakSet<Element>();
    const checkStuckLoading = (): void => {
      if (document.visibilityState === "hidden") return;
      const indicators = document.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"]',
      );
      const now = Date.now();
      for (const indicator of Array.from(indicators)) {
        if (isScanExempt(indicator)) continue;
        const rect = indicator.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const firstSeen = loadingFirstSeen.get(indicator);
        if (firstSeen === undefined) {
          loadingFirstSeen.set(indicator, now);
          continue;
        }
        if (
          now - firstSeen < stuckLoadingMs ||
          reportedStuckLoading.has(indicator)
        ) {
          continue;
        }
        reportedStuckLoading.add(indicator);
        reportScanIssue(
          indicator,
          BEACON_SIGNAL.STUCK_LOADING,
          `Stuck loading — ${describeElement(indicator)} never resolved`,
          { visibleMs: String(now - firstSeen) },
        );
      }
    };

    const runSettledScan = (): void => {
      if (detectOverflow) scanForOverflow();
      if (detectOcclusion) scanForOcclusion();
      if (detectInvisibleText) scanForInvisibleText();
      if (detectStuckLoading) checkStuckLoading();
    };

    const scheduleOverflowScan = (): void => {
      if (overflowTimer !== undefined) clearTimeout(overflowTimer);
      overflowTimer = setTimeout(() => {
        overflowTimer = undefined;
        runSettledScan();
      }, overflowSettleMs);
    };

    if (document.readyState === "complete") {
      scheduleOverflowScan();
    } else {
      const onLoad = (): void => scheduleOverflowScan();
      window.addEventListener("load", onLoad, { once: true });
      cleanups.push(() => window.removeEventListener("load", onLoad));
    }
    window.addEventListener("resize", scheduleOverflowScan);
    overflowScanOnNavigation = scheduleOverflowScan;
    cleanups.push(() => {
      window.removeEventListener("resize", scheduleOverflowScan);
      overflowScanOnNavigation = null;
      if (overflowTimer !== undefined) clearTimeout(overflowTimer);
    });
    if (detectStuckLoading) {
      const stuckTimer = setInterval(checkStuckLoading, STUCK_LOADING_POLL_MS);
      (stuckTimer as { unref?: () => void }).unref?.();
      cleanups.push(() => clearInterval(stuckTimer));
    }
  }

  // ——— Interaction watchdogs ———————————————————————————————————————————
  if (signals !== null && typeof document !== "undefined") {
    // Scroll jail: repeated wheel input over scrollable-but-immobile content
    // — the scroll lock a closed modal forgot to release. Boundary no-ops
    // (already at the top/bottom) and app-handled wheels (preventDefault:
    // carousels, canvas zoom) reset the burst instead of counting.
    if (signals.scrollJail !== false) {
      const nearestScrollable = (start: Element | null): Element | null => {
        let node = start;
        while (node !== null && node !== document.body) {
          const style = window.getComputedStyle(node);
          const overflowY = style.overflowY;
          if (
            (overflowY === "auto" || overflowY === "scroll") &&
            node.scrollHeight > node.clientHeight + 1
          ) {
            return node;
          }
          node = node.parentElement;
        }

        return null;
      };
      let jailBurst: Array<{ at: number; position: number }> = [];
      let jailScroller: Element | null = null;
      const reportedScrollers = new Set<string>();
      const onWheel = (event: WheelEvent): void => {
        if (event.ctrlKey || event.defaultPrevented || event.deltaY === 0) {
          jailBurst = [];

          return;
        }
        const target = event.target instanceof Element ? event.target : null;
        const scroller = nearestScrollable(target) ?? document.scrollingElement;
        if (!(scroller instanceof Element)) {
          jailBurst = [];

          return;
        }
        const scrollingDown = event.deltaY > 0;
        const canMove = scrollingDown
          ? scroller.scrollTop + scroller.clientHeight <
            scroller.scrollHeight - SCROLL_JAIL_BOUNDARY_TOLERANCE_PX
          : scroller.scrollTop > SCROLL_JAIL_BOUNDARY_TOLERANCE_PX;
        if (!canMove) {
          jailBurst = [];

          return;
        }
        const now = Date.now();
        if (jailScroller !== scroller) {
          jailScroller = scroller;
          jailBurst = [];
        }
        jailBurst = jailBurst.filter(
          (entry) => now - entry.at < SCROLL_JAIL_WINDOW_MS,
        );
        jailBurst.push({ at: now, position: scroller.scrollTop });
        if (jailBurst.length < SCROLL_JAIL_EVENT_COUNT) return;
        const first = jailBurst[0];
        const moved =
          first === undefined ||
          jailBurst.some((entry) => entry.position !== first.position) ||
          scroller.scrollTop !== first.position;
        jailBurst = [];
        if (moved) return;
        // An open overlay may lock page scroll on purpose.
        if (viewportCoveredByOverlay()) return;
        const descriptor = describeElement(scroller);
        if (reportedScrollers.has(descriptor)) return;
        reportedScrollers.add(descriptor);
        emitSignal(
          `Scroll jail — ${descriptor} has scrollable content but never moves — ${shortUrl(location.href)}`,
          { signal: BEACON_SIGNAL.SCROLL_JAIL, target: descriptor },
        );
      };
      document.addEventListener("wheel", onWheel, { passive: true });
      cleanups.push(() => document.removeEventListener("wheel", onWheel));
    }

    // Focus loss: a dialog unmounts while owning focus and keyboard users
    // land on <body> with no way to know where they are.
    if (signals.focusLoss !== false) {
      const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog';
      let lastDialogFocus: Element | null = null;
      const reportedFocusLoss = new Set<string>();
      const onFocusIn = (event: FocusEvent): void => {
        const target = event.target;
        lastDialogFocus =
          target instanceof Element && target.closest(DIALOG_SELECTOR) !== null
            ? target
            : null;
      };
      const onFocusOut = (): void => {
        const candidate = lastDialogFocus;
        if (candidate === null) return;
        setTimeout(() => {
          const active = document.activeElement;
          const focusDropped = active === null || active === document.body;
          if (!focusDropped || candidate.isConnected) return;
          const descriptor = describeElement(candidate);
          if (reportedFocusLoss.has(descriptor)) return;
          reportedFocusLoss.add(descriptor);
          emitSignal(
            `Focus lost — a dialog closed and dropped keyboard focus on body — ${shortUrl(location.href)}`,
            { lastFocused: descriptor, signal: BEACON_SIGNAL.FOCUS_LOST },
          );
        }, 0);
      };
      document.addEventListener("focusin", onFocusIn, true);
      document.addEventListener("focusout", onFocusOut, true);
      cleanups.push(() => {
        document.removeEventListener("focusin", onFocusIn, true);
        document.removeEventListener("focusout", onFocusOut, true);
      });
    }

    // Form frustration: the same form submitted with IDENTICAL values
    // repeatedly (retrying a thing that keeps not working — chat-style forms
    // that clear their input never match), or native validation blocking it
    // over and over.
    if (signals.formFrustration !== false) {
      type FormActivity = {
        identicalSubmits: number[];
        invalidBursts: number[];
        lastData: string | null;
        lastInvalidAt: number;
      };
      const formActivity = new WeakMap<HTMLFormElement, FormActivity>();
      const reportedForms = new WeakSet<HTMLFormElement>();
      const activityFor = (form: HTMLFormElement): FormActivity => {
        const existing = formActivity.get(form);
        if (existing !== undefined) return existing;
        const created: FormActivity = {
          identicalSubmits: [],
          invalidBursts: [],
          lastData: null,
          lastInvalidAt: 0,
        };
        formActivity.set(form, created);

        return created;
      };
      // Values are compared locally and never leave the page.
      const serializeForm = (form: HTMLFormElement): string | null => {
        try {
          return Array.from(new FormData(form).entries())
            .map(
              ([key, value]) =>
                `${key}=${typeof value === "string" ? value : "file"}`,
            )
            .join("&");
        } catch {
          return null;
        }
      };
      const reportForm = (form: HTMLFormElement, reason: string): void => {
        if (reportedForms.has(form)) return;
        reportedForms.add(form);
        emitSignal(
          `Form frustration — ${describeElement(form)} ${reason} — ${shortUrl(location.href)}`,
          {
            signal: BEACON_SIGNAL.FORM_FRUSTRATION,
            target: describeElement(form),
          },
        );
      };
      const onSubmit = (event: Event): void => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        const data = serializeForm(form);
        if (data === null) return;
        const activity = activityFor(form);
        const now = Date.now();
        if (data !== activity.lastData) {
          activity.lastData = data;
          activity.identicalSubmits = [now];

          return;
        }
        activity.identicalSubmits = activity.identicalSubmits.filter(
          (at) => now - at < FORM_FRUSTRATION_WINDOW_MS,
        );
        activity.identicalSubmits.push(now);
        if (activity.identicalSubmits.length >= FORM_FRUSTRATION_THRESHOLD) {
          reportForm(form, "was submitted with identical values repeatedly");
        }
      };
      const onInvalid = (event: Event): void => {
        const control = event.target;
        const form =
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement
            ? control.form
            : null;
        if (form === null) return;
        const activity = activityFor(form);
        const now = Date.now();
        // One burst per submit attempt — invalid fires once per bad field.
        if (now - activity.lastInvalidAt < FORM_INVALID_BURST_GAP_MS) {
          activity.lastInvalidAt = now;

          return;
        }
        activity.lastInvalidAt = now;
        activity.invalidBursts = activity.invalidBursts.filter(
          (at) => now - at < FORM_FRUSTRATION_WINDOW_MS,
        );
        activity.invalidBursts.push(now);
        if (activity.invalidBursts.length >= FORM_FRUSTRATION_THRESHOLD) {
          reportForm(form, "keeps failing native validation");
        }
      };
      document.addEventListener("submit", onSubmit, true);
      document.addEventListener("invalid", onInvalid, true);
      cleanups.push(() => {
        document.removeEventListener("submit", onSubmit, true);
        document.removeEventListener("invalid", onInvalid, true);
      });
    }
  }

  // ——— Stream & connection watchdogs ————————————————————————————————————
  // Stalled stream: an EventSource that is OPEN on a visible page but has
  // delivered nothing for `stalledStreamMs`. Named SSE event types bypass
  // "message", so the activity timer re-arms for every type the app
  // subscribes to. Comment-only heartbeats are invisible to the EventSource
  // API — pick a threshold above the real message cadence.
  if (
    signals !== null &&
    signals.stalledStreams !== false &&
    typeof window.EventSource === "function"
  ) {
    const stalledStreamMs =
      signals.stalledStreamMs ?? STALLED_STREAM_DEFAULT_MS;
    const OriginalEventSource = window.EventSource;
    const reportedStreams = new Set<string>();
    const instrumentSource = (
      source: EventSource,
      endpointLabel: string,
    ): void => {
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const disarm = (): void => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
      };
      const check = (): void => {
        if (source.readyState !== OriginalEventSource.OPEN) return;
        if (document.visibilityState === "hidden") {
          arm();

          return;
        }
        if (reportedStreams.has(endpointLabel)) return;
        reportedStreams.add(endpointLabel);
        emitSignal(
          `Stalled stream — ${endpointLabel} is open but silent — ${shortUrl(location.href)}`,
          {
            endpoint: endpointLabel,
            quietMs: String(stalledStreamMs),
            signal: BEACON_SIGNAL.STALLED_STREAM,
          },
        );
      };
      const arm = (): void => {
        disarm();
        stallTimer = setTimeout(check, stalledStreamMs);
      };
      const originalAddEventListener = source.addEventListener.bind(source);
      const armedTypes = new Set<string>(["error", "message", "open"]);
      source.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void => {
        if (!armedTypes.has(type)) {
          armedTypes.add(type);
          originalAddEventListener(type, arm);
        }
        if (listener !== null) {
          originalAddEventListener(type, listener, options);
        }
      }) as typeof source.addEventListener;
      originalAddEventListener("open", arm);
      originalAddEventListener("message", arm);
      originalAddEventListener("error", disarm);
      const originalClose = source.close.bind(source);
      source.close = (): void => {
        disarm();
        originalClose();
      };
      // Arm immediately too — the readyState guard in check() keeps a
      // still-connecting source from being miscounted as stalled.
      arm();
    };
    const wrappedEventSource = new Proxy(OriginalEventSource, {
      construct(target, args: unknown[]): object {
        const source = Reflect.construct(
          target,
          args,
        ) as unknown as EventSource;
        instrumentSource(source, shortUrl(String(args[0])));

        return source;
      },
    });
    window.EventSource = wrappedEventSource as typeof EventSource;
    cleanups.push(() => {
      if (window.EventSource === wrappedEventSource) {
        window.EventSource = OriginalEventSource;
      }
    });
  }

  // Socket flapping: repeated connect→close cycles to one URL — an auth or
  // heartbeat bug burning a reconnect loop. Page-teardown closes are exempt.
  if (
    signals !== null &&
    signals.socketFlapping !== false &&
    typeof window.WebSocket === "function"
  ) {
    const OriginalWebSocket = window.WebSocket;
    const closesByUrl = new Map<string, number[]>();
    const reportedSockets = new Set<string>();
    const wrappedWebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args: unknown[]): object {
        const socket = Reflect.construct(target, args) as unknown as WebSocket;
        const label = shortUrl(String(args[0]));
        socket.addEventListener("close", () => {
          if (pageLifecycleEnding) return;
          const now = Date.now();
          const closes = (closesByUrl.get(label) ?? []).filter(
            (at) => now - at < SOCKET_FLAP_WINDOW_MS,
          );
          closes.push(now);
          closesByUrl.set(label, closes);
          if (
            closes.length < SOCKET_FLAP_CYCLES ||
            reportedSockets.has(label)
          ) {
            return;
          }
          reportedSockets.add(label);
          emitSignal(
            `Socket flapping — ${label} keeps connecting and closing — ${shortUrl(location.href)}`,
            {
              closeCount: String(closes.length),
              endpoint: label,
              signal: BEACON_SIGNAL.SOCKET_FLAPPING,
              windowMs: String(SOCKET_FLAP_WINDOW_MS),
            },
          );
        });

        return socket;
      },
    });
    window.WebSocket = wrappedWebSocket as typeof WebSocket;
    cleanups.push(() => {
      if (window.WebSocket === wrappedWebSocket) {
        window.WebSocket = OriginalWebSocket;
      }
    });
  }

  // ——— Boot-time watchdogs ——————————————————————————————————————————————
  // Reload loop: several full page loads inside a minute — a crash loop, a
  // reload loop, or a user mashing refresh against a broken page.
  if (
    signals !== null &&
    signals.reloadLoops !== false &&
    typeof sessionStorage !== "undefined"
  ) {
    try {
      const now = Date.now();
      const raw = sessionStorage.getItem(RELOAD_LOOP_STORAGE_KEY);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      const times = (Array.isArray(parsed) ? parsed : []).filter(
        (at): at is number =>
          typeof at === "number" && now - at < RELOAD_LOOP_WINDOW_MS,
      );
      times.push(now);
      sessionStorage.setItem(RELOAD_LOOP_STORAGE_KEY, JSON.stringify(times));
      if (times.length >= RELOAD_LOOP_COUNT) {
        emitSignal(
          `Reload loop — repeated page loads within a minute — ${shortUrl(location.href)}`,
          {
            loadCount: String(times.length),
            signal: BEACON_SIGNAL.RELOAD_LOOP,
          },
        );
      }
    } catch {
      // Storage unavailable (private mode) — the detector stays off.
    }
  }

  // Stale release: this page's build is older than one this browser has
  // already run — a service worker or CDN cache serving yesterday's app. The
  // grace window keeps rolling deploys (both releases briefly live) quiet.
  if (
    signals !== null &&
    signals.staleReleases !== false &&
    typeof localStorage !== "undefined" &&
    typeof options.release === "string" &&
    options.release !== ""
  ) {
    try {
      const currentRelease = options.release;
      const now = Date.now();
      const raw = localStorage.getItem(STALE_RELEASE_STORAGE_KEY);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      const firstSeenByRelease: Record<string, number> = {};
      if (parsed !== null && typeof parsed === "object") {
        for (const [release, at] of Object.entries(parsed)) {
          if (typeof at === "number") firstSeenByRelease[release] = at;
        }
      }
      const currentFirstSeen = firstSeenByRelease[currentRelease] ?? now;
      firstSeenByRelease[currentRelease] = currentFirstSeen;
      const newest = Object.entries(firstSeenByRelease)
        .filter(
          ([release, at]) =>
            release !== currentRelease && at > currentFirstSeen,
        )
        .sort((left, right) => right[1] - left[1])[0];
      if (newest !== undefined && now - newest[1] > STALE_RELEASE_GRACE_MS) {
        emitSignal(
          `Stale release — this page is running a build older than one this browser already saw — ${shortUrl(location.href)}`,
          {
            currentRelease,
            newestRelease: newest[0],
            signal: BEACON_SIGNAL.STALE_RELEASE,
          },
        );
      }
      const trimmed = Object.fromEntries(
        Object.entries(firstSeenByRelease)
          .sort((left, right) => right[1] - left[1])
          .slice(0, STALE_RELEASE_HISTORY_LIMIT),
      );
      localStorage.setItem(STALE_RELEASE_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // Storage unavailable — skip.
    }
  }

  // Font failure: a FontFace that ended in error — icon fonts fall back to
  // raw ligature words ("chevron_right") and nobody files a report.
  if (
    signals !== null &&
    signals.fontFailures !== false &&
    typeof document !== "undefined" &&
    "fonts" in document
  ) {
    const reportedFonts = new Set<string>();
    const sweepFonts = (): void => {
      document.fonts.forEach((face) => {
        if (face.status !== "error" || reportedFonts.has(face.family)) return;
        reportedFonts.add(face.family);
        emitSignal(
          `Font failure — ${face.family} failed to load — ${shortUrl(location.href)}`,
          { fontFamily: face.family, signal: BEACON_SIGNAL.FONT_FAILURE },
        );
      });
    };
    const fontsReady: Promise<unknown> | undefined = document.fonts.ready;
    if (fontsReady !== undefined) {
      void fontsReady.then(sweepFonts).catch(() => undefined);
    }
    if (typeof document.fonts.addEventListener === "function") {
      document.fonts.addEventListener("loadingerror", sweepFonts);
      cleanups.push(() =>
        document.fonts.removeEventListener("loadingerror", sweepFonts),
      );
    }
  }

  // Request storm: one endpoint hammered repeatedly inside a short window —
  // a refetch loop or retry storm. Fed by the fetch/XHR wrappers below.
  if (signals !== null && signals.requestStorms !== false) {
    const stormWindowMs =
      signals.requestStormWindowMs ?? REQUEST_STORM_DEFAULT_WINDOW_MS;
    const stormCount = signals.requestStormCount ?? REQUEST_STORM_DEFAULT_COUNT;
    const hitsByEndpoint = new Map<string, number[]>();
    const reportedStorms = new Set<string>();
    recordRequestForStorm = (url, method) => {
      const label = `${method.toUpperCase()} ${shortUrl(url)}`;
      const now = Date.now();
      const hits = (hitsByEndpoint.get(label) ?? []).filter(
        (at) => now - at < stormWindowMs,
      );
      hits.push(now);
      hitsByEndpoint.set(label, hits);
      if (hits.length < stormCount || reportedStorms.has(label)) return;
      reportedStorms.add(label);
      emitSignal(
        `Request storm — ${label} hit repeatedly within seconds — ${shortUrl(location.href)}`,
        {
          endpoint: shortUrl(url),
          method: method.toUpperCase(),
          requestCount: String(hits.length),
          signal: BEACON_SIGNAL.REQUEST_STORM,
          windowMs: String(stormWindowMs),
        },
      );
    };
    cleanups.push(() => {
      recordRequestForStorm = null;
    });
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
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      // Never breadcrumb our own ingest POSTs — avoids a feedback loop.
      if (url.includes(endpoint)) return originalFetch(...args);
      const start = Date.now();
      networkRequestCount += 1;
      recordRequestForStorm?.(url, method);
      try {
        const response = await originalFetch(...args);
        addBreadcrumb({
          data: { status: response.status },
          message: `${method} ${url} → ${response.status}`,
          type: "fetch",
        });
        reportResponseSignal(
          url,
          method,
          response.status,
          Date.now() - start,
          responseTraceId(response.headers.get(BEACON_TRACE_HEADER)),
        );
        return response;
      } catch (error) {
        const resolved = toError(error);
        const outcome =
          failureKind(resolved) === "aborted" ? "aborted" : "failed";
        addBreadcrumb({
          data: { errorMessage: resolved.message, errorName: resolved.name },
          message: `${method} ${url} → ${outcome}`,
          type: "fetch",
        });
        reportFailureSignal(url, method, Date.now() - start, "fetch", error);
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

      return originalOpen.apply(this, [method, url, ...rest] as Parameters<
        typeof originalOpen
      >);
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest["send"]>
    ) {
      const request = meta.get(this);
      // Never breadcrumb our own ingest POSTs — avoids a feedback loop.
      if (request !== undefined && !request.url.includes(endpoint)) {
        const start = Date.now();
        networkRequestCount += 1;
        recordRequestForStorm?.(request.url, request.method);
        let outcome: "aborted" | "error" | "timeout" = "error";
        this.addEventListener(
          "abort",
          () => {
            outcome = "aborted";
          },
          { once: true },
        );
        this.addEventListener(
          "error",
          () => {
            outcome = "error";
          },
          { once: true },
        );
        this.addEventListener(
          "timeout",
          () => {
            outcome = "timeout";
          },
          { once: true },
        );
        this.addEventListener(
          "loadend",
          () => {
            const failed = this.status === 0;
            addBreadcrumb({
              data: {
                status: this.status,
                ...(failed ? { outcome } : {}),
              },
              message: `${request.method} ${request.url} → ${
                failed ? outcome : this.status
              }`,
              type: "xhr",
            });
            if (!failed) {
              reportResponseSignal(
                request.url,
                request.method,
                this.status,
                Date.now() - start,
                responseTraceId(this.getResponseHeader(BEACON_TRACE_HEADER)),
              );
            } else {
              const error = new Error(
                outcome === "timeout"
                  ? "XMLHttpRequest timed out"
                  : outcome === "aborted"
                    ? "XMLHttpRequest was aborted"
                    : "XMLHttpRequest completed with status 0",
              );
              error.name =
                outcome === "timeout"
                  ? "TimeoutError"
                  : outcome === "aborted"
                    ? "AbortError"
                    : "XMLHttpRequestError";
              reportFailureSignal(
                request.url,
                request.method,
                Date.now() - start,
                "xhr",
                error,
              );
            }
          },
          { once: true },
        );
      }

      return originalSend.apply(this, args);
    };
    cleanups.push(() => {
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
    });
  }

  if (instrument.history !== false && typeof history !== "undefined") {
    const record = (): void => {
      addBreadcrumb({
        message: `navigate ${location.pathname}${location.search}`,
        type: "navigation",
      });
      // The new route's layout deserves the same overflow check as a resize.
      overflowScanOnNavigation?.();
    };
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

  const onPageHide = (): void => {
    pageLifecycleEnding = true;
    // Browsers do not consistently surface navigation-cancelled fetches as
    // AbortError. Chromium can reject them with TypeError("Failed to fetch"),
    // so discard only pending generic transport failures during page teardown.
    // Offline and timeout failures remain actionable and are still flushed.
    pendingNetworkFailures.delete("transport");
    void flush(true);
  };
  const onPageShow = (): void => {
    pageLifecycleEnding = false;
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") void flush(true);
  };
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibilityChange);
  cleanups.push(
    () => window.removeEventListener("pagehide", onPageHide),
    () => window.removeEventListener("pageshow", onPageShow),
    () => document.removeEventListener("visibilitychange", onVisibilityChange),
  );

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
export const captureMessage = (
  message: string,
  level?: BeaconLevel,
  context?: CaptureMessageContext,
): void => current?.captureMessage(message, level, context);

/** Add a breadcrumb to the global beacon (no-op if uninitialized). */
export const addBreadcrumb = (crumb: {
  message: string;
  type?: Breadcrumb["type"];
  data?: Record<string, unknown>;
}): void => current?.addBreadcrumb(crumb);
