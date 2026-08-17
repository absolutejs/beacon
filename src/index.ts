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
  AUTH_FAILURE_STORM: "auth_failure_storm",
  BROWSER_INTERVENTION: "browser_intervention",
  BROWSER_POLICY_VIOLATION: "browser_policy_violation",
  BFCACHE_BLOCKED: "bfcache_blocked",
  CAPABILITY_FAILURE: "capability_failure",
  BLANK_APP_ROOT: "blank_app_root",
  CONSOLE_ERROR: "console_error",
  CONTROL_COLLISION: "control_collision",
  CSP_VIOLATION: "csp_violation",
  CLIPBOARD_FAILURE: "clipboard_failure",
  DEAD_CLICK: "dead_click",
  DISRUPTIVE_LAYOUT_SHIFT: "disruptive_layout_shift",
  DOCUMENT_DISCARDED: "document_discarded",
  ERROR_CLICK: "error_click",
  FETCH_FAILED: "fetch_failed",
  FOCUS_LOST: "focus_lost",
  FONT_FAILURE: "font_failure",
  FORM_FRUSTRATION: "form_frustration",
  FORM_ABANDONMENT: "form_abandonment",
  FOCUSED_CONTROL_OFFSCREEN: "focused_control_offscreen",
  HTTP_5XX: "http_5xx",
  INVISIBLE_TEXT: "invisible_text",
  EMBEDDED_CONTENT_STALLED: "embedded_content_stalled",
  LAYOUT_OVERFLOW: "layout_overflow",
  MAIN_THREAD_STALL: "main_thread_stall",
  MEDIA_PLAYBACK_FAILED: "media_playback_failed",
  MEDIA_PLAYBACK_STALLED: "media_playback_stalled",
  MODAL_FOCUS_ESCAPE: "modal_focus_escape",
  OCCLUDED_CONTROL: "occluded_control",
  RAGE_CLICK: "rage_click",
  RATE_LIMITED: "rate_limited",
  NAVIGATION_STALLED: "navigation_stalled",
  RELOAD_LOOP: "reload_loop",
  REQUEST_STORM: "request_storm",
  SEMANTIC_RESPONSE_FAILURE: "semantic_response_failure",
  SCROLL_JAIL: "scroll_jail",
  SLOW_RESPONSE: "slow_response",
  SLOW_RESOURCE: "slow_resource",
  SLOW_INTERACTION: "slow_interaction",
  SOCKET_ABNORMAL_CLOSE: "socket_abnormal_close",
  SOCKET_FLAPPING: "socket_flapping",
  SSE_FLAPPING: "sse_flapping",
  STALE_RELEASE: "stale_release",
  STALLED_STREAM: "stalled_stream",
  STUCK_LOADING: "stuck_loading",
  THEME_MISMATCH: "theme_mismatch",
  THRASHED_CURSOR: "thrashed_cursor",
  STORAGE_FAILURE: "storage_failure",
  WEBGL_CONTEXT_LOST: "webgl_context_lost",
  SERVICE_WORKER_FAILURE: "service_worker_failure",
  WORKER_FAILURE: "worker_failure",
} as const;

export type BeaconSignal = (typeof BEACON_SIGNAL)[keyof typeof BEACON_SIGNAL];

/** Stable DOM attributes understood by Beacon's instrumentation. */
export const BEACON_ATTRIBUTE = {
  /** Names an application root whose settled empty state is a failure. */
  APP_ROOT: "data-beacon-app-root",
  DEAD_CLICK: "data-beacon-dead-click",
  NAME: "data-beacon-name",
  /** Names an iframe whose initial load should be watched for a stall. */
  EMBED: "data-beacon-embed",
  /** Marks loading UI that should participate in the stuck-loading watchdog. */
  LOADING: "data-beacon-loading",
  /** Overrides the stuck-loading deadline for one loading element, in ms. */
  LOADING_TIMEOUT: "data-beacon-loading-timeout",
  /** Names a form whose dirty navigation should be reported as abandonment. */
  FORM: "data-beacon-form",
  /** Names media whose user-visible playback should be watched. */
  MEDIA: "data-beacon-media",
  /** `="allow"` exempts an element AND its subtree from layout-overflow
   * detection — for deliberate bleeds (decorative shapes, marquees). */
  OVERFLOW: "data-beacon-overflow",
  /** `="allow"` exempts an element AND its subtree from the visual scan
   * detectors (occluded controls, invisible text, stuck loading). */
  SCAN: "data-beacon-scan",
  /** `="adaptive"` opts a subtree into theme-polarity checks; `="allow"`
   * exempts an intentional opposite-theme surface and its subtree. */
  THEME: "data-beacon-theme",
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
  /** Record Network Information API changes as breadcrumbs. Default true. */
  networkChanges?: boolean;
  /** Record application-authored Performance API measures as breadcrumbs.
   * Default false because measure names are host-owned. */
  userTiming?: boolean;
  /** Privacy-owned application classifier for successful HTTP responses that
   * encode a semantic failure (for example GraphQL errors in an HTTP 200).
   * Beacon never reads or stores the response body itself. */
  classifyResponse?: (
    response: Response,
    request: { method: string; url: string },
  ) =>
    | void
    | false
    | { groupingKey: string; message: string; tags?: Record<string, string> }
    | Promise<
        | void
        | false
        | {
            groupingKey: string;
            message: string;
            tags?: Record<string, string>;
          }
      >;
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
 * server failures, policy violations, worker/realtime faults, and
 * `console.error`. Each detector is feature-gated and independently tunable.
 */
export type BeaconSignals = {
  /** Back/forward navigations the browser could not restore from bfcache. */
  bfcacheBlocks?: boolean;
  /** Browser-specific bfcache reason strings that are inherent to an
   * application's required capabilities and therefore not actionable. */
  ignoredBfcacheReasons?: string[];
  /** Marked application roots that settle without meaningful visible content. */
  blankAppRoots?: boolean;
  /** Delay before an application root is evaluated. Default 3000ms. */
  blankAppRootSettleMs?: number;
  /** Repeated 401/403 responses from one endpoint inside a short window.
   *  Default true. */
  authFailureStorms?: boolean;
  /** Authorization failures from one endpoint that trip a storm. Default 4. */
  authFailureStormCount?: number;
  /** Window for the authorization-failure storm counter. Default 30000ms. */
  authFailureStormWindowMs?: number;
  /** Browser intervention reports surfaced by ReportingObserver. Default true. */
  browserInterventions?: boolean;
  /** Deprecation, permissions-policy, integrity, and cross-origin policy
   * reports exposed by ReportingObserver. Default true. */
  browserPolicyViolations?: boolean;
  /** Enforced Content Security Policy violations. Default true. */
  cspViolations?: boolean;
  /** Rejected clipboard writes, including failures handled by application
   * code. Clipboard contents are never captured. Default true. */
  clipboardFailures?: boolean;
  /** Interactive controls from separate layout groups that overlap or render
   * with effectively no spacing. Intentional control groups and positioned
   * controls that merely touch are excluded. Default true. */
  controlCollisions?: boolean;
  /** Maximum non-overlapping gap that counts as touching controls. Default
   * 1px. */
  controlCollisionGapPx?: number;
  /** N rapid clicks in roughly the same spot. Default true. */
  rageClicks?: boolean;
  /** An interactive control clicked with no DOM/nav/scroll/focus/request response. Default true. */
  deadClicks?: boolean;
  /** A user interaction followed shortly by an error. Default true. */
  errorClicks?: boolean;
  /** Correlation window between interaction and error. Default 2000ms. */
  errorClickWindowMs?: number;
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
  /** Time a visible failed face must remain unavailable before it is reported.
   * The face is retried at both ends of the window. Default 5000ms. */
  fontFailureConfirmMs?: number;
  /** The same form submitted or failing native validation repeatedly within a
   *  minute — the quiet sibling of a rage click. Default true. */
  formFrustration?: boolean;
  /** Dirty marked forms left without a successful submission. Default true. */
  formAbandonment?: boolean;
  /** A focused editable control left outside the mobile visual viewport after
   *  the on-screen keyboard settles. Default true. */
  focusedControlsOffscreen?: boolean;
  /** Grace period after focus/visual-viewport movement. Default 500ms. */
  focusedControlSettleMs?: number;
  /** Opt-in iframes marked with `data-beacon-embed` that never fire their
   *  initial load event. Default true. */
  embeddedContentStalls?: boolean;
  /** Initial iframe load deadline. Default 15000ms. */
  embeddedContentStallMs?: number;
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
  /** Large unexpected Layout Instability API entries with culprit elements. */
  disruptiveLayoutShifts?: boolean;
  /** Individual unexpected shift score that becomes an issue. Default 0.1. */
  disruptiveLayoutShiftMin?: number;
  /** A page reloaded after the browser discarded its previous document. */
  documentDiscards?: boolean;
  /** Maximum layout-overflow issues reported per page load. Default 5. */
  layoutOverflowMaxReports?: number;
  /** Quiet period after load/resize/navigation before the settled visual
   *  scan runs, letting transitions and lazy content settle. Default 600ms. */
  layoutOverflowSettleMs?: number;
  /** Repeated long animation frames/tasks on a visible page. Default true. */
  mainThreadStalls?: boolean;
  /** Responding interactions that exceed the latency threshold. Default true. */
  slowInteractions?: boolean;
  /** Interaction duration that becomes a warning. Default 1000ms. */
  slowInteractionMs?: number;
  /** Opt-in marked media playback failures and sustained stalls. Default true. */
  mediaFailures?: boolean;
  /** Time continuously waiting/stalled before reporting. Default 10000ms. */
  mediaStallMs?: number;
  /** Blocking duration that counts as a main-thread stall. Default 200ms. */
  mainThreadStallMs?: number;
  /** Stalls inside the window that trip a report. Default 3. */
  mainThreadStallCount?: number;
  /** Window for repeated main-thread stalls. Default 10000ms. */
  mainThreadStallWindowMs?: number;
  /** Focus outside an open modal, including a modal that never receives
   *  initial focus. Default true. */
  modalFocusEscape?: boolean;
  /** Sampled `elementFromPoint` check for interactive controls covered by an
   *  unrelated element (leaked scrims, z-index bugs). Skipped entirely while
   *  a dialog is open. Default true. */
  occludedControls?: boolean;
  /** Rapid-click count that trips a rage click. Default 3. */
  rageClickCount?: number;
  /** HTTP 429 responses. Default true. */
  rateLimits?: boolean;
  /** Several full page loads within a minute — a crash or reload loop.
   *  Default true. */
  reloadLoops?: boolean;
  /** SPA navigations accepted by a router but never settled. Default true. */
  stalledNavigations?: boolean;
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
  /** Service-worker registration and installation failures. Default true. */
  serviceWorkerFailures?: boolean;
  /** Grace period for a transient service-worker registration failure to
   *  recover through an application retry before it becomes an issue. Persistent
   *  browser rejections still report immediately. Default 8000ms. */
  serviceWorkerRecoveryMs?: number;
  /** Abnormal WebSocket closes (`wasClean: false` or non-normal codes).
   *  Default true. */
  socketAbnormalCloses?: boolean;
  /** Endpoints whose client explicitly owns reconnect/resume. An isolated
   *  abnormal close is suppressed for matching URLs, while every close still
   *  counts toward socket-flapping detection. String patterns are URL/path
   *  prefixes; RegExp patterns match the full URL. */
  recoverableSockets?: Array<RegExp | string>;
  /** WebSocket connect/close cycles to one URL tripping a flap report.
   *  Default true. */
  socketFlapping?: boolean;
  /** Repeated EventSource error/reconnect cycles. Default true. */
  sseFlapping?: boolean;
  /** EventSource failures that trip a flap report. Default 4. */
  sseFlapCount?: number;
  /** Window for EventSource flap detection. Default 60000ms. */
  sseFlapWindowMs?: number;
  /** This page's `release` is older than one this browser has already run —
   *  a service worker or cache serving a stale build. Default true. */
  staleReleases?: boolean;
  /** An open `EventSource` on a visible page with no message for
   *  `stalledStreamMs` — the silent-stream failure. Default true. */
  stalledStreams?: boolean;
  /** Quiet period before an open, visible EventSource counts as stalled.
   *  Default 60000ms. */
  stalledStreamMs?: number;
  /** Endpoints that are quiet by design — push topics that only emit when
   *  something changes, so silence is health, not failure. Streams whose URL
   *  matches a string prefix or RegExp here are exempt from the
   *  stalled-stream signal (flap detection still applies). */
  quietStreams?: Array<RegExp | string>;
  /** An `aria-busy`/`role="status"`/`role="progressbar"` element still
   *  visible after `stuckLoadingMs` — a load that silently hung.
   *  Default true. */
  stuckLoading?: boolean;
  /** Age at which a visible loading indicator counts as stuck.
   *  Default 20000ms. */
  stuckLoadingMs?: number;
  /** Opposite-polarity opaque surfaces inside subtrees explicitly marked
   *  `data-beacon-theme="adaptive"`. Default true. */
  themeMismatches?: boolean;
  /** Visible surface area required for theme-polarity checks. Default
   *  10000px². */
  themeMismatchMinArea?: number;
  /** Visible area required when the opposite-polarity surface is itself an
   *  interactive control. Default 1500px². */
  themeMismatchControlMinArea?: number;
  /** Visible WebGL canvases whose context remains lost after a restoration
   *  grace period. Default true. */
  webglContextLosses?: boolean;
  /** Grace period for `webglcontextrestored`. Default 2000ms. */
  webglRestoreGraceMs?: number;
  /** Dedicated/shared worker construction, runtime, and message decoding
   *  failures. Default true. */
  workerFailures?: boolean;
  /**
   * Maximum wait for a same-origin link accepted by an SPA router to finish
   * navigating before it is considered dead. Default 8000ms; never shorter
   * than the normal 1500ms dead-click window.
   */
  navigationResponseMs?: number;
  /** Slow-response threshold (ms). Default 8000. */
  slowResponseMs?: number;
  /** Slow successful static resources from Resource Timing. Default true. */
  slowResources?: boolean;
  /** Static resource duration that becomes a warning. Default 5000ms. */
  slowResourceMs?: number;
  /** Browser storage writes and IndexedDB operations that fail. Default true. */
  storageFailures?: boolean;
  /** Erratic desktop pointer movement indicating confusion/waiting. Default true. */
  thrashedCursors?: boolean;
  /** Cursor direction reversals inside the detection window. Default 8. */
  thrashedCursorReversals?: number;
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
  connection?: {
    downlink?: number;
    effectiveType?: string;
    rtt?: number;
    saveData?: boolean;
  };
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
  /** The 5 Core Web Vitals, plus TBT measured for 10 seconds from FCP. */
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
  /** Privacy-bounded field attribution supplied by web-vitals/attribution. */
  attribution?: Record<string, unknown>;
};

/** Override Web Vital delivery without changing collection semantics. */
export type BeaconVitalsTransport = (vital: WebVital) => void | Promise<void>;

type WebVitalMetric = {
  name: string;
  value: number;
  rating: string;
  id: string;
  navigationType: string;
  attribution?: Record<string, unknown>;
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
  /** Observe an application-owned browser capability promise without globally
   * monkey-patching sensitive platform APIs. */
  observeCapability: <T>(name: string, operation: Promise<T>) => Promise<T>;
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
  "blockeduri",
  "endpoint",
  "errorfilename",
  "reporturl",
  "resourceurl",
  "sourcefile",
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
const META_IOS_WEBKIT_BRIDGE_FAILURES = new Set([
  META_IOS_WEBKIT_BRIDGE_FAILURE,
]);
const matchesErrorMessage = (
  event: Pick<BeaconEvent, "message" | "name">,
  expected: ReadonlySet<string>,
) =>
  expected.has(event.message) ||
  expected.has(`${event.name}: ${event.message}`);
const isInstagramIosBridgeInjection = (
  event: Pick<BeaconEvent, "message" | "name" | "stack">,
  userAgent: string,
) =>
  INSTAGRAM_IOS_IN_APP_BROWSER.test(userAgent) &&
  matchesErrorMessage(event, META_IOS_WEBKIT_BRIDGE_FAILURES) &&
  event.stack?.includes("sendDataToNative") === true &&
  event.stack.includes("sendPageHideMessage");
const FACEBOOK_ANDROID_DETACHED_BRIDGE_MESSAGE =
  "Error invoking postMessage: Java object is gone";
const FACEBOOK_ANDROID_PERFORMANCE_LOGGER =
  "iabjs://navigation_performance_logger_android";
const KNOWN_CRAWLER_USER_AGENT =
  /(?:AdsBot-Google|Googlebot|bingbot|Baiduspider|YandexBot|DuckDuckBot|Applebot|Bytespider|PetalBot|SemrushBot|AhrefsBot|DotBot|MJ12bot|GPTBot|ClaudeBot|PerplexityBot|Google-NotebookLM|BitSightBot|Dataprovider\.com|meta-external(?:agent|ads))/i;
const GOOGLE_WEB_RENDERER_SERVICE_WORKER_WRAPPER =
  "wrsParams.serviceWorkers.navigator.serviceWorker.register";
const EXTENSION_STACK_PROTOCOL = /(?:chrome|moz|safari-web)-extension:\/\//u;
const isExtensionOnlyStack = (event: Pick<BeaconEvent, "stack">): boolean => {
  const frames = (event.stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    frames.length > 0 &&
    frames.every((frame) => EXTENSION_STACK_PROTOCOL.test(frame))
  );
};
const isInjectedServiceWorkerRejection = (
  event: Pick<BeaconEvent, "message" | "stack">,
): boolean => {
  const stack = event.stack ?? "";
  if (stack.includes(GOOGLE_WEB_RENDERER_SERVICE_WORKER_WRAPPER)) return true;
  return (
    event.message === "Rejected" &&
    stack.includes("ServiceWorkerContainer.<anonymous> (<anonymous>:") &&
    stack.includes("ServiceWorkerContainer.register (<anonymous>:")
  );
};

const browserUserAgent = (): string =>
  typeof navigator === "undefined" ? "" : navigator.userAgent;

/** Known browser-host/scanner failures that do not originate in page code. */
export const isKnownBeaconNoise = (
  event: Pick<BeaconEvent, "message" | "name" | "stack" | "tags">,
  userAgent = browserUserAgent(),
): boolean =>
  KNOWN_CRAWLER_USER_AGENT.test(userAgent) ||
  (event.name === "UnhandledRejection" &&
    CEF_SHARP_REJECTION.test(event.message)) ||
  (FACEBOOK_IOS_IN_APP_BROWSER.test(userAgent) &&
    matchesErrorMessage(event, FACEBOOK_IOS_HOST_INJECTION)) ||
  isInstagramIosBridgeInjection(event, userAgent) ||
  isInjectedServiceWorkerRejection(event) ||
  isExtensionOnlyStack(event) ||
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

const isExtensionResourceUrl = (url: string | undefined): boolean => {
  if (url === undefined) return false;
  try {
    const protocol = new URL(url, location.href).protocol;
    return protocol === "chrome-extension:" || protocol === "moz-extension:";
  } catch {
    return false;
  }
};

const injectionMarkersOf = (element: Element): string | undefined => {
  const markers = new Set<string>();
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    for (const attribute of Array.from(current.attributes)) {
      if (
        /^(?:data-darkreader|data-adguard|data-extension|data-gramm|data-lastpass|bis_)/u.test(
          attribute.name,
        )
      ) {
        markers.add(attribute.name);
      }
    }
  }
  return markers.size === 0 ? undefined : Array.from(markers).sort().join(",");
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

const BFCACHE_LOCATION_MAX = 240;
const bfcacheLocation = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    const parsed = new URL(value, location.href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }

    return `${parsed.origin}${normalizeSignalIdentityPart(parsed.pathname)}`.slice(
      0,
      BFCACHE_LOCATION_MAX,
    );
  } catch {
    return undefined;
  }
};

const UUID_PATH_SEGMENT =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const LONG_IDENTIFIER_SEGMENT = /\b(?:[0-9a-f]{16,}|\d{8,})\b/giu;
const VOLATILE_SIGNAL_TAGS = new Set([
  "actionId",
  "blockingDurationMs",
  "blockingFrameDurationMs",
  "blockerLocations",
  "blockerScope",
  "closeCount",
  "currentRelease",
  "durationMs",
  "elapsedMs",
  "errorCount",
  "inputDelayMs",
  "interactionId",
  "loadCount",
  "newestRelease",
  "obscuredPx",
  "presentationDelayMs",
  "processingDurationMs",
  "responseMs",
  "shiftValue",
  "signal",
  "spillPx",
  "stallCount",
  "thresholdMs",
  "userAgent",
  "viewportHeight",
  "viewportWidth",
  "windowMs",
]);

const normalizeSignalIdentityPart = (value: string): string =>
  value
    .replace(UUID_PATH_SEGMENT, ":id")
    .replace(LONG_IDENTIFIER_SEGMENT, ":id")
    .slice(0, SIGNAL_IDENTITY_PART_MAX);

const SIGNAL_IDENTITY_PART_MAX = 160;
const stableIdentityHash = (value: string, seed: number): string => {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const signalGroupingKey = (
  signalTags: BeaconTags & { signal: BeaconSignal },
): string => {
  const identity = [
    `route=${normalizeSignalIdentityPart(shortUrl(location.href))}`,
    ...Object.entries(signalTags)
      .filter(([key]) => !VOLATILE_SIGNAL_TAGS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, value]) =>
          `${key}=${normalizeSignalIdentityPart(String(value))}`,
      ),
  ].join("|");
  const hash =
    stableIdentityHash(identity, 0x811c9dc5) +
    stableIdentityHash(identity, 0x9e3779b9);
  return `beacon-signal:${signalTags.signal}:${hash}`;
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
// values are compared locally and are never included in Beacon telemetry. A
// control can update an input outside a <form> (for example a modal password
// generator), so fall back to the dialog or document instead of ignoring it.
const snapshotRelevantFormControls = (
  control: Element,
): Map<FormControl, string> | null => {
  const nearest = control.closest("form");
  const associated =
    control instanceof HTMLButtonElement || control instanceof HTMLInputElement
      ? control.form
      : null;
  const root =
    nearest ?? associated ?? control.closest('[role="dialog"]') ?? document;
  const snapshot = new Map<FormControl, string>();
  const elements =
    root instanceof HTMLFormElement
      ? Array.from(root.elements)
      : Array.from(root.querySelectorAll("input, select, textarea"));
  for (const element of elements) {
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
const TBT_WINDOW_MS = 10_000;
const TBT_GOOD_MS = 200;
const TBT_POOR_MS = 600;

// Observe long tasks (>50ms) and report their overage during a bounded window
// from FCP. This is intentionally not accumulated for the page lifetime: doing
// so makes long-lived pages incomparable and can misattribute later activity.
const observeLongTasks = (
  report: (metric: WebVitalMetric) => void,
  navigationType: string,
): void => {
  if (typeof PerformanceObserver === "undefined") return;
  const longTasks: Array<{ duration: number; startTime: number }> = [];
  let reported = false;
  try {
    const observer = new PerformanceObserver((list) => {
      const windowStart =
        performance.getEntriesByName("first-contentful-paint")[0]?.startTime ??
        0;
      const windowEnd = windowStart + TBT_WINDOW_MS;
      for (const entry of list.getEntries()) {
        if (entry.startTime < windowStart || entry.startTime >= windowEnd)
          continue;
        longTasks.push({
          duration: entry.duration,
          startTime: entry.startTime,
        });
      }
    });
    observer.observe({ buffered: true, type: "longtask" });
    const flush = (): void => {
      if (reported) return;
      const firstContentfulPaint = performance.getEntriesByName(
        "first-contentful-paint",
      )[0]?.startTime;
      const windowStart = firstContentfulPaint ?? 0;
      const windowEnd = windowStart + TBT_WINDOW_MS;
      const tasksInWindow = longTasks.filter(
        ({ startTime }) => startTime >= windowStart && startTime < windowEnd,
      );
      if (tasksInWindow.length === 0) return;
      reported = true;
      const value = Math.round(
        tasksInWindow.reduce(
          (total, { duration }) => total + Math.max(0, duration - LONG_TASK_MS),
          0,
        ),
      );
      report({
        attribution: {
          measurementWindow:
            firstContentfulPaint === undefined ? "navigation" : "FCP",
          measurementWindowMs: TBT_WINDOW_MS,
        },
        id: `tbt-${navigationType}-${TBT_WINDOW_MS}-${value}`,
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

const vitalAttribution = (
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  const allowed = [
    "element",
    "elementRenderDelay",
    "inputDelay",
    "interactionTarget",
    "interactionType",
    "largestShiftTarget",
    "largestShiftValue",
    "loadState",
    "measurementWindow",
    "measurementWindowMs",
    "presentationDelay",
    "processingDuration",
    "resourceLoadDelay",
    "resourceLoadDuration",
    "timeToFirstByte",
    "url",
  ];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    const item = value[key];
    if (typeof item === "string") result[key] = item.slice(0, 300);
    else if (typeof item === "number" || typeof item === "boolean")
      result[key] = item;
  }

  return Object.keys(result).length === 0 ? undefined : result;
};

const loadWebVitals = async (): Promise<WebVitalsModule> => {
  const mod =
    (await import("web-vitals/attribution")) as unknown as WebVitalsModule;

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
  observeCapability: async <T>(_name: string, operation: Promise<T>) =>
    operation,
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
  const ERROR_CLICK_WINDOW_DEFAULT_MS = 2000;
  const SLOW_INTERACTION_DEFAULT_MS = 1000;
  const BLANK_APP_ROOT_SETTLE_DEFAULT_MS = 3000;
  const DISRUPTIVE_LAYOUT_SHIFT_DEFAULT_MIN = 0.1;
  const SLOW_RESOURCE_DEFAULT_MS = 5000;
  const MEDIA_STALL_DEFAULT_MS = 10000;
  const THRASHED_CURSOR_DEFAULT_REVERSALS = 8;
  const THRASHED_CURSOR_WINDOW_MS = 2000;
  // Count an intentional change of direction, not a sign change from harmless
  // perpendicular jitter. A cosine of -0.5 is a turn of at least 120 degrees.
  const THRASHED_CURSOR_REVERSAL_COSINE = -0.5;
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
  const CONTROL_COLLISION_SAMPLE_LIMIT = 80;
  const CONTROL_COLLISION_DEFAULT_GAP_PX = 1;
  const CONTROL_COLLISION_MIN_CROSS_AXIS_RATIO = 0.5;
  const CONTROL_COLLISION_OVERLAP_TOLERANCE_PX = 1;
  const INVISIBLE_TEXT_SAMPLE_LIMIT = 40;
  const INVISIBLE_TEXT_CONTRAST_MAX = 1.2;
  const THEME_SURFACE_SAMPLE_LIMIT = 200;
  const THEME_MISMATCH_DEFAULT_MIN_AREA = 10000;
  const THEME_MISMATCH_CONTROL_DEFAULT_MIN_AREA = 1500;
  const THEME_DARK_SURFACE_LUMINANCE_MAX = 0.12;
  const THEME_LIGHT_SURFACE_LUMINANCE_MIN = 0.85;
  const STUCK_LOADING_DEFAULT_MS = 20000;
  const STUCK_LOADING_POLL_MS = 5000;
  const EMBEDDED_CONTENT_STALL_DEFAULT_MS = 15000;
  const WEBGL_RESTORE_GRACE_DEFAULT_MS = 2000;
  const FOCUSED_CONTROL_SETTLE_DEFAULT_MS = 500;
  const FONT_FAILURE_CONFIRM_DEFAULT_MS = 5000;
  const KEYBOARD_VIEWPORT_HEIGHT_RATIO_MAX = 0.8;
  const SCROLL_JAIL_EVENT_COUNT = 8;
  const SCROLL_JAIL_WINDOW_MS = 2000;
  // Passive wheel listeners can run before a composited scroll is reflected
  // in main-thread scrollTop. Mobile Safari has taken roughly 250ms in live
  // replays, so require a full quiet period beyond that observed delay before
  // deciding that a scrollable element is actually immobile.
  const SCROLL_JAIL_SETTLE_MS = 500;
  const SCROLL_JAIL_BOUNDARY_TOLERANCE_PX = 2;
  const AUTH_FAILURE_STORM_DEFAULT_COUNT = 4;
  const AUTH_FAILURE_STORM_DEFAULT_WINDOW_MS = 30000;
  const REQUEST_STORM_DEFAULT_COUNT = 15;
  const REQUEST_STORM_DEFAULT_WINDOW_MS = 10000;
  const SOCKET_FLAP_CYCLES = 4;
  const SOCKET_FLAP_WINDOW_MS = 60000;
  const SSE_FLAP_DEFAULT_COUNT = 4;
  const SSE_FLAP_DEFAULT_WINDOW_MS = 60000;
  const STALLED_STREAM_DEFAULT_MS = 60000;
  const SERVICE_WORKER_RECOVERY_DEFAULT_MS = 8000;
  const MODAL_FOCUS_SETTLE_MS = 100;
  const MAIN_THREAD_STALL_DEFAULT_MS = 200;
  const MAIN_THREAD_STALL_DEFAULT_COUNT = 3;
  const MAIN_THREAD_STALL_DEFAULT_WINDOW_MS = 10000;
  const RELOAD_LOOP_COUNT = 4;
  const RELOAD_LOOP_WINDOW_MS = 60000;
  const NAVIGATION_INTENT_MAX_AGE_MS = 30000;
  // v4 excludes document loads immediately following an intentional form or
  // same-tab link navigation. Do not inherit v3 history: a login submission
  // redirected back to the same path may already have polluted that streak.
  const RELOAD_LOOP_STORAGE_KEY = "beacon:reload-history-v4";
  const NAVIGATION_INTENT_STORAGE_KEY = "beacon:navigation-intent-v1";
  const STALE_RELEASE_STORAGE_KEY = "beacon:release-first-seen";
  const STALE_RELEASE_GRACE_MS = 600000;
  const STALE_RELEASE_HISTORY_LIMIT = 5;
  // BFCache can deliver an old socket's queued close after `pageshow`, when the
  // page is active again. Keep that prior lifecycle attributable briefly
  // without hiding genuinely later transport failures on the restored page.
  const RESTORED_SOCKET_CLOSE_GRACE_MS = 1000;
  const FORM_FRUSTRATION_THRESHOLD = 3;
  const FORM_FRUSTRATION_WINDOW_MS = 60000;
  const LAYOUT_SHIFT_RECENT_INTERACTION_MS = 500;
  const LAYOUT_SHIFT_VIEWPORT_RESIZE_SETTLE_MS = 500;
  const VIEWPORT_RESIZE_HISTORY_LIMIT = 8;
  const FORM_INVALID_BURST_GAP_MS = 100;
  const SIGNAL_TEXT_MAX = 180;
  const NON_TEXT_ENTRY_INPUT_TYPES = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ]);
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
  let externalShareCount = 0;
  let nativeFilePickerCount = 0;
  let clipboardWriteCount = 0;
  let inSignalConsole = false;
  let pageLifecycleEnding = false;
  let pageLifecycleGeneration = 0;
  let pageRestoredAt: number | undefined;
  let recentInteraction:
    | {
        at: number;
        performanceAt: number;
        target: string;
        type: "click" | "submit" | "keyboard";
      }
    | undefined;
  let reportErrorClick: ((errorName: string) => void) | null = null;
  let reportFormAbandonmentOnNavigation:
    ((departedUrl?: string) => void) | null = null;
  const focusedEditable = (): HTMLElement | null => {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement) return active;
    if (active instanceof HTMLInputElement) {
      return NON_TEXT_ENTRY_INPUT_TYPES.has(active.type) ? null : active;
    }
    if (active instanceof HTMLElement && active.isContentEditable)
      return active;
    return null;
  };
  const mobileKeyboardViewportActive = (): boolean => {
    const visualViewport = window.visualViewport;
    return (
      visualViewport !== undefined &&
      visualViewport !== null &&
      visualViewport.height > 0 &&
      window.innerHeight > 0 &&
      visualViewport.height <
        window.innerHeight * KEYBOARD_VIEWPORT_HEIGHT_RATIO_MAX &&
      focusedEditable() !== null
    );
  };
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
        ...(vitalAttribution(metric.attribution) === undefined
          ? {}
          : { attribution: vitalAttribution(metric.attribution) }),
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
  let pendingNavigationIntentAt: number | undefined;
  let tags: BeaconTags = {};
  let user: { id?: string; email?: string } | undefined;
  let actionSequence = 0;
  let activeAction:
    { at: number; id: string; target: string; type: string } | undefined;
  const beginAction = (type: string, target: string): void => {
    actionSequence += 1;
    activeAction = {
      at: Date.now(),
      id: `${sessionId}:${actionSequence}`,
      target,
      type,
    };
  };

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
    const action =
      activeAction !== undefined && Date.now() - activeAction.at <= 10_000
        ? activeAction
        : undefined;
    const mergedTags = {
      ...tags,
      ...(action === undefined
        ? {}
        : {
            actionId: action.id,
            actionTarget: action.target,
            actionType: action.type,
          }),
      ...event.tags,
    };
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
    useDefaultFingerprint = false,
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
      ...(useDefaultFingerprint
        ? {}
        : { groupingKey: signalGroupingKey(signalTags) }),
      level: "warning",
      tags: signalTags,
      ...(traceId !== undefined ? { traceId } : {}),
      ...(extra !== undefined ? { extra } : {}),
    });
  };

  if (signals !== null && signals.errorClicks !== false) {
    const windowMs =
      signals.errorClickWindowMs ?? ERROR_CLICK_WINDOW_DEFAULT_MS;
    reportErrorClick = (errorName): void => {
      const interaction = recentInteraction;
      if (interaction === undefined || Date.now() - interaction.at > windowMs)
        return;
      recentInteraction = undefined;
      emitSignal(
        `Error click — ${interaction.target} — ${shortUrl(location.href)}`,
        {
          errorName,
          interactionType: interaction.type,
          signal: BEACON_SIGNAL.ERROR_CLICK,
          target: interaction.target,
        },
      );
    };
    cleanups.push(() => {
      reportErrorClick = null;
    });
  }

  const observeCapability: Beacon["observeCapability"] = async (
    name,
    operation,
  ) => {
    try {
      return await operation;
    } catch (error) {
      const resolved = toError(error);
      captureException(
        errorWithoutStack(
          "CapabilityFailure",
          `Browser capability failed — ${name}`,
        ),
        {
          groupingKey: `browser-capability:${name}`,
          level: "warning",
          tags: {
            capability: name.slice(0, SIGNAL_TEXT_MAX),
            errorName: resolved.name,
            signal: BEACON_SIGNAL.CAPABILITY_FAILURE,
          },
        },
      );
      throw error;
    }
  };

  const responseTraceId = (value: string | null): string | undefined => {
    const traceId = value?.trim().toLowerCase();

    return traceId !== undefined && /^[0-9a-f]{32}$/.test(traceId)
      ? traceId
      : undefined;
  };

  const authFailureStormCount =
    signals?.authFailureStormCount ?? AUTH_FAILURE_STORM_DEFAULT_COUNT;
  const authFailureStormWindowMs =
    signals?.authFailureStormWindowMs ?? AUTH_FAILURE_STORM_DEFAULT_WINDOW_MS;
  const authFailuresByEndpoint = new Map<
    string,
    Array<{ at: number; status: number }>
  >();
  const reportedAuthFailureStorms = new Set<string>();
  const recordAuthFailure = (
    endpoint: string,
    method: string,
    status: number,
  ): boolean => {
    if (signals === null || signals.authFailureStorms === false) return false;
    const label = `${method} ${endpoint}`;
    const now = Date.now();
    const failures = (authFailuresByEndpoint.get(label) ?? []).filter(
      ({ at }) => now - at < authFailureStormWindowMs,
    );
    failures.push({ at: now, status });
    authFailuresByEndpoint.set(label, failures);
    if (
      failures.length < authFailureStormCount ||
      reportedAuthFailureStorms.has(label)
    ) {
      return false;
    }
    reportedAuthFailureStorms.add(label);
    const statuses = [...new Set(failures.map((failure) => failure.status))];
    emitSignal(
      `Authorization failure storm — ${label} repeatedly rejected requests — ${shortUrl(location.href)}`,
      {
        endpoint,
        failureCount: String(failures.length),
        method,
        signal: BEACON_SIGNAL.AUTH_FAILURE_STORM,
        statuses: statuses.join(","),
        windowMs: String(authFailureStormWindowMs),
      },
    );

    return true;
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
    if (signals.rateLimits !== false && status === 429) {
      emitSignal(
        `Rate limited — ${responseMethod} ${responseEndpoint} returned 429`,
        {
          endpoint: responseEndpoint,
          method: responseMethod,
          signal: BEACON_SIGNAL.RATE_LIMITED,
          status: String(status),
        },
        traceId,
      );
      return;
    }
    if (
      (status === 401 || status === 403) &&
      recordAuthFailure(responseEndpoint, responseMethod, status)
    ) {
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
    const connection = (
      navigator as Navigator & {
        connection?: {
          downlink?: number;
          effectiveType?: string;
          rtt?: number;
          saveData?: boolean;
        };
      }
    ).connection;

    return {
      ...(connection === undefined
        ? {}
        : {
            connection: {
              ...(typeof connection.downlink === "number"
                ? { downlink: connection.downlink }
                : {}),
              ...(typeof connection.effectiveType === "string"
                ? { effectiveType: connection.effectiveType }
                : {}),
              ...(typeof connection.rtt === "number"
                ? { rtt: connection.rtt }
                : {}),
              ...(typeof connection.saveData === "boolean"
                ? { saveData: connection.saveData }
                : {}),
            },
          }),
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
      ...(state.connection === undefined
        ? {}
        : { connection: state.connection }),
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
    report: (responded: boolean, navigationStalled: boolean) => void,
  ): void => {
    const urlBefore = location.href;
    const scrollBefore = window.scrollY;
    const activeBefore = document.activeElement;
    const formBefore = snapshotRelevantFormControls(control);
    const networkRequestsBefore = networkRequestCount;
    const externalNavigationsBefore = externalNavigationCount;
    const externalSharesBefore = externalShareCount;
    const nativeFilePickersBefore = nativeFilePickerCount;
    const clipboardWritesBefore = clipboardWriteCount;
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
      externalNavigationCount !== externalNavigationsBefore ||
      externalShareCount !== externalSharesBefore ||
      nativeFilePickerCount !== nativeFilePickersBefore ||
      clipboardWriteCount !== clipboardWritesBefore;
    const finish = (didRespond: boolean, navigationStalled = false): void => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      control.removeEventListener("click", observeRouterAcceptance);
      if (timer !== undefined) window.clearTimeout(timer);
      pendingClickCleanups.delete(cancel);
      report(didRespond, navigationStalled);
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
      finish(true);
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
      timer = window.setTimeout(() => {
        const didRespond = responded();
        finish(didRespond, !didRespond);
      }, navigationResponseMs - DEAD_CLICK_WINDOW_MS);
    }, DEAD_CLICK_WINDOW_MS);
  };

  // The route + stable control descriptor belongs in the message because
  // @absolutejs/errors fingerprints browser events from name/message/stack.
  // Keeping it only in tags would collapse unrelated controls into one issue.
  const clickSignalMessage = (message: string, control: Element): string =>
    `${message} — ${shortUrl(location.href)} — ${describeElement(control)}`;

  // --- auto-instrumentation -------------------------------------------------

  if (
    signals !== null &&
    signals.cspViolations !== false &&
    typeof document !== "undefined"
  ) {
    const reportedViolations = new Set<string>();
    const onSecurityPolicyViolation = (event: Event): void => {
      const violation = event as SecurityPolicyViolationEvent;
      if (violation.disposition !== "enforce") return;
      const directive =
        violation.effectiveDirective ||
        violation.violatedDirective ||
        "unknown";
      const blockedUri = violation.blockedURI || "unknown";
      const key = `${directive}|${blockedUri}`;
      if (reportedViolations.has(key)) return;
      reportedViolations.add(key);
      emitSignal(
        `CSP violation — ${directive} blocked a resource — ${shortUrl(location.href)}`,
        {
          blockedUri,
          directive,
          disposition: violation.disposition,
          signal: BEACON_SIGNAL.CSP_VIOLATION,
          ...(violation.sourceFile === ""
            ? {}
            : { sourceFile: violation.sourceFile }),
          ...(violation.lineNumber > 0
            ? { sourceLine: String(violation.lineNumber) }
            : {}),
        },
      );
    };
    document.addEventListener(
      "securitypolicyviolation",
      onSecurityPolicyViolation,
    );
    cleanups.push(() =>
      document.removeEventListener(
        "securitypolicyviolation",
        onSecurityPolicyViolation,
      ),
    );
  }

  if (
    signals !== null &&
    signals.browserInterventions !== false &&
    typeof ReportingObserver !== "undefined"
  ) {
    try {
      const reportedInterventions = new Set<string>();
      const observer = new ReportingObserver(
        (reports) => {
          for (const report of reports) {
            if (report.type !== "intervention") continue;
            const body = report.body as unknown as {
              columnNumber?: unknown;
              id?: unknown;
              lineNumber?: unknown;
              message?: unknown;
              sourceFile?: unknown;
            };
            const interventionId =
              typeof body.id === "string" && body.id !== ""
                ? body.id.slice(0, SIGNAL_TEXT_MAX)
                : "browser-intervention";
            const reportUrl = report.url || location.href;
            const key = `${interventionId}|${shortUrl(reportUrl)}`;
            if (reportedInterventions.has(key)) continue;
            reportedInterventions.add(key);
            emitSignal(
              `Browser intervention — ${interventionId} — ${shortUrl(location.href)}`,
              {
                interventionId,
                reportUrl,
                signal: BEACON_SIGNAL.BROWSER_INTERVENTION,
                ...(typeof body.sourceFile === "string"
                  ? { sourceFile: body.sourceFile }
                  : {}),
                ...(typeof body.lineNumber === "number"
                  ? { sourceLine: String(body.lineNumber) }
                  : {}),
              },
              undefined,
              {
                ...(typeof body.message === "string"
                  ? {
                      interventionMessage: body.message.slice(
                        0,
                        SIGNAL_TEXT_MAX,
                      ),
                    }
                  : {}),
              },
            );
          }
        },
        { buffered: true, types: ["intervention"] },
      );
      observer.observe();
      cleanups.push(() => observer.disconnect());
    } catch {
      // ReportingObserver is optional and partially implemented by browsers.
    }
  }

  if (
    signals !== null &&
    signals.browserPolicyViolations !== false &&
    typeof ReportingObserver !== "undefined"
  ) {
    try {
      const reportTypes = [
        "deprecation",
        "permissions-policy-violation",
        "integrity-violation",
        "coep",
      ];
      const reported = new Set<string>();
      const observer = new ReportingObserver(
        (reports) => {
          for (const report of reports) {
            const body = report.body as unknown as {
              id?: unknown;
              sourceFile?: unknown;
              lineNumber?: unknown;
            };
            const id =
              typeof body.id === "string" && body.id !== ""
                ? body.id.slice(0, SIGNAL_TEXT_MAX)
                : report.type;
            const key = `${report.type}|${id}|${shortUrl(report.url || location.href)}`;
            if (reported.has(key)) continue;
            reported.add(key);
            emitSignal(
              `Browser policy violation — ${report.type} ${id} — ${shortUrl(location.href)}`,
              {
                policyId: id,
                reportType: report.type,
                reportUrl: report.url || location.href,
                signal: BEACON_SIGNAL.BROWSER_POLICY_VIOLATION,
                ...(typeof body.sourceFile === "string"
                  ? { sourceFile: body.sourceFile }
                  : {}),
                ...(typeof body.lineNumber === "number"
                  ? { sourceLine: String(body.lineNumber) }
                  : {}),
              },
            );
          }
        },
        { buffered: true, types: reportTypes },
      );
      observer.observe();
      cleanups.push(() => observer.disconnect());
    } catch {
      // Policy report types are experimental and independently implemented.
    }
  }

  if (
    signals !== null &&
    signals.mainThreadStalls !== false &&
    typeof PerformanceObserver !== "undefined"
  ) {
    const stallMs = signals.mainThreadStallMs ?? MAIN_THREAD_STALL_DEFAULT_MS;
    const stallCount =
      signals.mainThreadStallCount ?? MAIN_THREAD_STALL_DEFAULT_COUNT;
    const stallWindowMs =
      signals.mainThreadStallWindowMs ?? MAIN_THREAD_STALL_DEFAULT_WINDOW_MS;
    let stallTimes: number[] = [];
    let reported = false;
    try {
      const observer = new PerformanceObserver((list) => {
        if (reported || document.visibilityState === "hidden") return;
        for (const entry of list.getEntries()) {
          const animationFrame = entry as PerformanceEntry & {
            blockingDuration?: number;
            scripts?: Array<{
              duration?: number;
              functionName?: string;
              invoker?: string;
              sourceURL?: string;
            }>;
          };
          const blockingDuration =
            entry.entryType === "long-animation-frame" &&
            animationFrame.blockingDuration !== undefined
              ? animationFrame.blockingDuration
              : entry.duration;
          if (blockingDuration < stallMs) continue;
          // PerformanceObserver may deliver several buffered entries in one
          // callback. Date.now() would give every entry the same timestamp and
          // turn unrelated historical frames into a false burst. startTime is
          // the entry's monotonic time relative to this document.
          const entryAt = entry.startTime;
          stallTimes = stallTimes.filter(
            (at) => entryAt >= at && entryAt - at < stallWindowMs,
          );
          stallTimes.push(entryAt);
          if (stallTimes.length < stallCount) continue;
          reported = true;
          const script = [...(animationFrame.scripts ?? [])].sort(
            (left, right) => (right.duration ?? 0) - (left.duration ?? 0),
          )[0];
          emitSignal(
            `Main-thread stall — repeated long frames blocked the page — ${shortUrl(location.href)}`,
            {
              ...(animationFrame.blockingDuration === undefined
                ? {}
                : {
                    blockingDurationMs: String(
                      Math.round(animationFrame.blockingDuration),
                    ),
                  }),
              durationMs: String(Math.round(entry.duration)),
              entryType: entry.entryType,
              signal: BEACON_SIGNAL.MAIN_THREAD_STALL,
              ...(script?.functionName === undefined
                ? {}
                : { scriptFunction: script.functionName }),
              ...(script?.invoker === undefined
                ? {}
                : { scriptInvoker: script.invoker }),
              ...(script?.sourceURL === undefined
                ? {}
                : { scriptSource: shortUrl(script.sourceURL) }),
              stallCount: String(stallTimes.length),
              windowMs: String(stallWindowMs),
            },
          );
          break;
        }
      });
      const supportedTypes = PerformanceObserver.supportedEntryTypes;
      let observing = false;
      if (supportedTypes?.includes("long-animation-frame")) {
        observer.observe({ buffered: true, type: "long-animation-frame" });
        observing = true;
      } else if (supportedTypes?.includes("longtask")) {
        observer.observe({ buffered: true, type: "longtask" });
        observing = true;
      } else if (supportedTypes === undefined || supportedTypes.length === 0) {
        // Test doubles and older implementations may not expose the static
        // support list; try the modern type and let the outer guard catch it.
        observer.observe({ buffered: true, type: "long-animation-frame" });
        observing = true;
      } else {
        observer.disconnect();
      }
      if (observing) cleanups.push(() => observer.disconnect());
    } catch {
      // Neither long-animation-frame nor longtask is supported.
    }
  }

  if (signals !== null && typeof document !== "undefined") {
    const discardedDocument = document as Document & { wasDiscarded?: boolean };
    if (
      signals.documentDiscards !== false &&
      discardedDocument.wasDiscarded === true
    ) {
      emitSignal(
        `Document discarded — the browser reloaded a discarded tab — ${shortUrl(location.href)}`,
        { signal: BEACON_SIGNAL.DOCUMENT_DISCARDED },
      );
    }

    if (signals.bfcacheBlocks !== false && typeof performance !== "undefined") {
      const ignoredBfcacheReasons = new Set(
        signals.ignoredBfcacheReasons ?? [],
      );
      const navigation = performance.getEntriesByType("navigation")[0] as
        | (PerformanceNavigationTiming & {
            notRestoredReasons?: {
              children?: unknown[];
              reasons?: Array<{ reason?: string }>;
            } | null;
          })
        | undefined;
      if (
        navigation?.type === "back_forward" &&
        navigation.notRestoredReasons != null
      ) {
        const reasons = new Set<string>();
        const blockers: Array<{
          depth: number;
          location?: string;
          reasons: string[];
        }> = [];
        const visit = (node: unknown, depth = 0): void => {
          if (node === null || typeof node !== "object") return;
          const detail = node as {
            children?: unknown[];
            src?: unknown;
            url?: unknown;
            reasons?: Array<{ reason?: unknown }>;
          };
          const nodeReasons = (detail.reasons ?? [])
            .map((reason) => reason.reason)
            .filter(
              (reason): reason is string =>
                typeof reason === "string" &&
                reason !== "masked" &&
                !ignoredBfcacheReasons.has(reason),
            )
            .slice(0, 10);
          for (const reason of nodeReasons) reasons.add(reason);
          if (nodeReasons.length > 0 && blockers.length < 10) {
            const location = bfcacheLocation(detail.url ?? detail.src);
            blockers.push({
              depth,
              ...(location === undefined ? {} : { location }),
              reasons: nodeReasons,
            });
          }
          for (const child of detail.children ?? []) visit(child, depth + 1);
        };
        visit(navigation.notRestoredReasons);
        const reasonList = [...reasons].slice(0, 10);
        if (reasonList.length > 0) {
          const hasTopDocumentBlocker = blockers.some(
            (blocker) => blocker.depth === 0,
          );
          const hasChildFrameBlocker = blockers.some(
            (blocker) => blocker.depth > 0,
          );
          const blockerScope =
            hasTopDocumentBlocker && hasChildFrameBlocker
              ? "mixed"
              : hasChildFrameBlocker
                ? "child-frame"
                : "top-document";
          const blockerLocations = [
            ...new Set(
              blockers
                .map((blocker) => blocker.location)
                .filter((value): value is string => value !== undefined),
            ),
          ].slice(0, 10);
          emitSignal(
            `Back-forward cache blocked — ${reasonList.join(", ")} — ${shortUrl(location.href)}`,
            {
              ...(blockerLocations.length === 0
                ? {}
                : { blockerLocations: blockerLocations.join(",") }),
              blockerScope,
              reasons: reasonList.join(","),
              signal: BEACON_SIGNAL.BFCACHE_BLOCKED,
            },
            undefined,
            { bfcacheBlockers: blockers },
          );
        }
      }
    }
  }

  if (instrument.networkChanges !== false && typeof navigator !== "undefined") {
    const connection = (
      navigator as Navigator & {
        connection?: EventTarget & {
          downlink?: number;
          effectiveType?: string;
          rtt?: number;
          saveData?: boolean;
        };
      }
    ).connection;
    if (connection !== undefined) {
      const onConnectionChange = (): void => {
        addBreadcrumb({
          data: {
            ...(typeof connection.downlink === "number"
              ? { downlink: connection.downlink }
              : {}),
            ...(typeof connection.effectiveType === "string"
              ? { effectiveType: connection.effectiveType }
              : {}),
            ...(typeof connection.rtt === "number"
              ? { rtt: connection.rtt }
              : {}),
            ...(typeof connection.saveData === "boolean"
              ? { saveData: connection.saveData }
              : {}),
          },
          message: "Network quality changed",
          type: "custom",
        });
      };
      connection.addEventListener("change", onConnectionChange);
      cleanups.push(() =>
        connection.removeEventListener("change", onConnectionChange),
      );
    }
  }

  if (
    instrument.userTiming === true &&
    typeof PerformanceObserver !== "undefined"
  ) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          addBreadcrumb({
            data: { durationMs: Math.round(entry.duration) },
            message: `Performance measure ${entry.name.slice(0, SIGNAL_TEXT_MAX)}`,
            type: "custom",
          });
        }
      });
      observer.observe({ buffered: true, type: "measure" });
      cleanups.push(() => observer.disconnect());
    } catch {
      // User Timing observation is optional in older browsers.
    }
  }

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
        reportErrorClick?.(error.name);
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
        reportErrorClick?.(reason.name);
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
      reportErrorClick?.("UnhandledRejection");
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
              true,
            );
          if (text !== "") reportErrorClick?.("ConsoleError");
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

  // Clipboard writes are commonly caught by application code, hiding a
  // user-visible failure from the global rejection handler. The attempted
  // clipboard contents are deliberately never inspected or retained.
  if (
    signals !== null &&
    signals.clipboardFailures !== false &&
    typeof navigator !== "undefined" &&
    navigator.clipboard !== undefined &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    const clipboard = navigator.clipboard;
    const originalWriteText = clipboard.writeText;
    const wrappedWriteText: Clipboard["writeText"] = async (value) => {
      const target =
        typeof document !== "undefined" &&
        document.activeElement instanceof Element
          ? describeElement(document.activeElement)
          : "unknown";
      const activation = navigator.userActivation?.isActive ?? false;
      try {
        const result = await originalWriteText.call(clipboard, value);
        clipboardWriteCount += 1;

        return result;
      } catch (error) {
        if (
          !pageLifecycleEnding &&
          typeof document !== "undefined" &&
          document.visibilityState !== "hidden"
        ) {
          const resolved = toError(error);
          emitSignal(
            `Clipboard write failed — ${target} — ${shortUrl(location.href)}`,
            {
              errorName: resolved.name,
              secureContext: String(globalThis.isSecureContext === true),
              signal: BEACON_SIGNAL.CLIPBOARD_FAILURE,
              target,
              userActivation: String(activation),
            },
          );
        }
        throw error;
      }
    };
    try {
      clipboard.writeText = wrappedWriteText;
      cleanups.push(() => {
        clipboard.writeText = originalWriteText;
      });
    } catch {
      // Some browser hosts expose a non-writable Clipboard object.
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

      if (
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function"
      ) {
        const originalShare = navigator.share;
        const wrappedShare: Navigator["share"] = (...args) => {
          // Opening the browser-owned share sheet is the response. Its promise
          // may remain pending while the user reads, shares, or dismisses it,
          // so count invocation synchronously rather than awaiting settlement.
          externalShareCount += 1;

          return originalShare.apply(navigator, args);
        };
        try {
          navigator.share = wrappedShare;
          cleanups.push(() => {
            if (navigator.share === wrappedShare)
              navigator.share = originalShare;
          });
        } catch {
          // Some browser hosts expose a non-writable share function.
        }
      }

      // A custom attachment button commonly delegates to a visually hidden
      // `<input type="file">`. Opening the browser-owned picker does not mutate
      // the page, move focus, or start a request, and the picker may remain open
      // past the dead-click window. Count a completed programmatic activation
      // as the response without inspecting the selected file or its contents.
      const inputPrototype = HTMLInputElement.prototype;
      const originalInputClick = inputPrototype.click;
      const wrappedInputClick = function (this: HTMLInputElement): void {
        originalInputClick.call(this);
        if (this.type === "file") nativeFilePickerCount += 1;
      };
      try {
        inputPrototype.click = wrappedInputClick;
        cleanups.push(() => {
          if (inputPrototype.click === wrappedInputClick)
            inputPrototype.click = originalInputClick;
        });
      } catch {
        // Some browser hosts expose non-writable element prototypes.
      }
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
      const targetName = describeElement(target);
      beginAction("click", targetName);
      addBreadcrumb({ message: targetName, type: "click" });
      if (signals === null) return;
      recentInteraction = {
        at: Date.now(),
        performanceAt: performance.now(),
        target: targetName,
        type: "click",
      };
      const control = deadClickCandidate(target, event);
      if (control === null) return;
      const detectRage =
        signals.rageClicks !== false && event instanceof MouseEvent;
      const detectDead = signals.deadClicks !== false;
      if (!detectRage && !detectDead) return;
      const clickedAt = Date.now();
      const x = event instanceof MouseEvent ? event.clientX : 0;
      const y = event instanceof MouseEvent ? event.clientY : 0;
      observeClickResponse(control, event, (responded, navigationStalled) => {
        if (responded) {
          // A response between repeated clicks breaks the rage sequence.
          unresponsiveClicks = unresponsiveClicks.filter(
            (click) => click.control !== control,
          );
          return;
        }
        if (navigationStalled && signals.stalledNavigations !== false) {
          emitSignal(
            clickSignalMessage(
              "Navigation stalled — accepted route never settled",
              control,
            ),
            {
              signal: BEACON_SIGNAL.NAVIGATION_STALLED,
              target: describeElement(control),
            },
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
    const onInteractionSubmit = (event: Event): void => {
      if (!(event.target instanceof HTMLFormElement)) return;
      const target = describeElement(event.target);
      beginAction("submit", target);
      recentInteraction = {
        at: Date.now(),
        performanceAt: performance.now(),
        target,
        type: "submit",
      };
    };
    const onInteractionKey = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const targetName = describeElement(target);
      beginAction("keyboard", targetName);
      recentInteraction = {
        at: Date.now(),
        performanceAt: performance.now(),
        target: targetName,
        type: "keyboard",
      };
    };
    document.addEventListener("submit", onInteractionSubmit, true);
    document.addEventListener("keydown", onInteractionKey, true);
    cleanups.push(() => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onInteractionSubmit, true);
      document.removeEventListener("keydown", onInteractionKey, true);
    });
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
  //   control collisions — controls in separate layout groups whose border
  //     boxes overlap or leave effectively no visual spacing. Same-parent and
  //     semantic button groups are exempt from the near-touching check.
  //   invisible text — sampled headings/controls whose text color composites
  //     to (nearly) the same color as their opaque background — the classic
  //     theme-token bug. Gradients/images and translucent stacks are skipped.
  //   stuck loading — `aria-busy`/`role="progressbar"` indicators still
  //     visible after `stuckLoadingMs` (or their element-specific
  //     `data-beacon-loading-timeout` override). Checked on a slow poll as
  //     well, so a spinner that never resolves is caught without any action.
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
    const detectControlCollision = signals.controlCollisions !== false;
    const detectInvisibleText = signals.invisibleText !== false;
    const detectStuckLoading = signals.stuckLoading !== false;
    const detectThemeMismatch = signals.themeMismatches !== false;
    const detectBlankAppRoot = signals.blankAppRoots !== false;
    const overflowSettleMs =
      signals.layoutOverflowSettleMs ?? LAYOUT_OVERFLOW_SETTLE_DEFAULT_MS;
    const overflowMaxReports =
      signals.layoutOverflowMaxReports ?? LAYOUT_OVERFLOW_MAX_REPORTS_DEFAULT;
    const stuckLoadingMs = signals.stuckLoadingMs ?? STUCK_LOADING_DEFAULT_MS;
    const themeMismatchMinArea =
      signals.themeMismatchMinArea ?? THEME_MISMATCH_DEFAULT_MIN_AREA;
    const themeMismatchControlMinArea =
      signals.themeMismatchControlMinArea ??
      THEME_MISMATCH_CONTROL_DEFAULT_MIN_AREA;
    const controlCollisionGapPx = Math.max(
      0,
      signals.controlCollisionGapPx ?? CONTROL_COLLISION_DEFAULT_GAP_PX,
    );
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

    const hasHiddenAncestor = (
      element: Element,
      requirePointerEvents = false,
    ): boolean => {
      let current: Element | null = element;
      while (current !== null) {
        if (
          current.hasAttribute("hidden") ||
          current.hasAttribute("inert") ||
          current.getAttribute("aria-hidden") === "true"
        ) {
          return true;
        }
        const style = window.getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity || "1") <= 0.01 ||
          (requirePointerEvents && style.pointerEvents === "none")
        ) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    };

    const isMaterialIconGlyph = (element: Element): boolean =>
      [...element.classList].some(
        (name) =>
          name === "material-icons" || name.startsWith("material-symbols"),
      );

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
      const rect = element.getBoundingClientRect();
      const resourceUrl = RESOURCE_ERROR_TAGS.has(element.tagName.toLowerCase())
        ? resourceUrlOf(element)
        : undefined;
      const injectionMarkers = injectionMarkersOf(element);
      emitSignal(
        `Layout overflow — ${describeElement(element)} ${detail} — ${shortUrl(location.href)} [${bucket}]`,
        {
          overflowKind: kind,
          signal: BEACON_SIGNAL.LAYOUT_OVERFLOW,
          spillPx: String(Math.round(spillPx)),
          target: describeElement(element),
          targetAncestor:
            element.parentElement === null
              ? "none"
              : describeElement(element.parentElement),
          targetBottomPx: String(Math.round(rect.bottom)),
          targetHeightPx: String(Math.round(rect.height)),
          targetLeftPx: String(Math.round(rect.left)),
          targetPosition: window.getComputedStyle(element).position,
          targetRightPx: String(Math.round(rect.right)),
          targetTopPx: String(Math.round(rect.top)),
          targetWidthPx: String(Math.round(rect.width)),
          ...(resourceUrl === undefined
            ? {}
            : { resourceSource: resourceSourceOf(resourceUrl) }),
          ...(injectionMarkers === undefined ? {} : { injectionMarkers }),
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
        if (
          RESOURCE_ERROR_TAGS.has(element.tagName.toLowerCase()) &&
          isExtensionResourceUrl(resourceUrlOf(element))
        ) {
          return;
        }
        const style = window.getComputedStyle(element);
        if (hasHiddenAncestor(element)) return;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        if (
          rect.width <= 2 &&
          rect.height <= 2 &&
          (style.overflowX === "hidden" ||
            style.overflowX === "clip" ||
            style.overflowY === "hidden" ||
            style.overflowY === "clip")
        ) {
          // Screen-reader-only labels and live regions commonly use a 1px
          // clipped box while retaining their full text in the accessibility
          // tree. Their scroll dimensions describe intentionally hidden copy,
          // not visible application content being cut off.
          return;
        }
        if (
          (style.position === "absolute" || style.position === "fixed") &&
          (rect.right <= 0 ||
            rect.left >= viewportRight ||
            rect.bottom <= 0 ||
            rect.top >= document.documentElement.clientHeight)
        ) {
          return;
        }
        const inFlow =
          style.position !== "absolute" && style.position !== "fixed";

        if (inFlow && !isMaterialIconGlyph(element)) {
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
          // A classic vertical scrollbar reduces clientWidth while the
          // element's border-box and scrollWidth remain equal. That gutter is
          // not horizontally clipped application content.
          const horizontalContentWidth = Math.max(
            element.clientWidth,
            rect.width,
          );
          const clipPx = element.scrollWidth - horizontalContentWidth;
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

    type VisibleRect = {
      bottom: number;
      left: number;
      right: number;
      top: number;
    };
    const CONTROL_SELECTOR =
      'a[href], button, input, select, textarea, [role="button"]';
    const INTENTIONAL_CONTROL_GROUP_SELECTOR =
      'nav, [role="group"], [role="menu"], [role="radiogroup"], [role="tablist"], [role="toolbar"]';
    const clipsAxis = (overflow: string): boolean =>
      overflow === "auto" ||
      overflow === "scroll" ||
      overflow === "hidden" ||
      overflow === "clip";
    const visibleControlRect = (
      control: Element,
      rect: DOMRect,
      viewportWidth: number,
      viewportHeight: number,
    ): VisibleRect | null => {
      const visible: VisibleRect = {
        bottom: Math.min(rect.bottom, viewportHeight),
        left: Math.max(rect.left, 0),
        right: Math.min(rect.right, viewportWidth),
        top: Math.max(rect.top, 0),
      };
      for (
        let ancestor = control.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = window.getComputedStyle(ancestor);
        const clipX = clipsAxis(style.overflowX);
        const clipY = clipsAxis(style.overflowY);
        if (!clipX && !clipY) continue;
        const ancestorRect = ancestor.getBoundingClientRect();
        if (clipX) {
          visible.left = Math.max(visible.left, ancestorRect.left);
          visible.right = Math.min(visible.right, ancestorRect.right);
        }
        if (clipY) {
          visible.top = Math.max(visible.top, ancestorRect.top);
          visible.bottom = Math.min(visible.bottom, ancestorRect.bottom);
        }
        if (visible.left >= visible.right || visible.top >= visible.bottom) {
          return null;
        }
      }
      const centerX = (rect.left + rect.right) / 2;
      const centerY = (rect.top + rect.bottom) / 2;
      if (
        centerX < visible.left ||
        centerX > visible.right ||
        centerY < visible.top ||
        centerY > visible.bottom
      ) {
        return null;
      }

      return visible;
    };

    const isExtensionOwnedCover = (element: Element): boolean => {
      if (element.tagName !== "IFRAME") return false;
      const source = element.getAttribute("src")?.trim().toLowerCase() ?? "";
      return (
        source.startsWith("chrome-extension:") ||
        source.startsWith("moz-extension:") ||
        source.startsWith("safari-web-extension:")
      );
    };

    const sharedIntentionalControlGroup = (
      first: Element,
      second: Element,
    ): boolean => {
      const firstGroup = first.closest(INTENTIONAL_CONTROL_GROUP_SELECTOR);

      return (
        firstGroup !== null &&
        firstGroup === second.closest(INTENTIONAL_CONTROL_GROUP_SELECTOR)
      );
    };

    const crossesDialogBoundary = (
      first: Element,
      second: Element,
    ): boolean => {
      const firstDialog = first.closest('[role="dialog"], dialog');
      const secondDialog = second.closest('[role="dialog"], dialog');

      return (firstDialog === null) !== (secondDialog === null);
    };

    const scanForControlCollisions = (): void => {
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const controls: Array<{
        element: Element;
        positioned: boolean;
        rect: VisibleRect;
      }> = [];
      for (const element of Array.from(
        document.querySelectorAll(CONTROL_SELECTOR),
      )) {
        if (controls.length >= CONTROL_COLLISION_SAMPLE_LIMIT) break;
        if (isScanExempt(element) || hasHiddenAncestor(element, true)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const visible = visibleControlRect(
          element,
          rect,
          viewportWidth,
          viewportHeight,
        );
        if (visible === null) continue;
        const position = window.getComputedStyle(element).position;
        controls.push({
          element,
          positioned: position === "absolute" || position === "fixed",
          rect: visible,
        });
      }

      for (let firstIndex = 0; firstIndex < controls.length; firstIndex += 1) {
        const first = controls[firstIndex];
        if (first === undefined) continue;
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < controls.length;
          secondIndex += 1
        ) {
          const second = controls[secondIndex];
          if (second === undefined) continue;
          if (
            first.element.contains(second.element) ||
            second.element.contains(first.element) ||
            crossesDialogBoundary(first.element, second.element)
          ) {
            continue;
          }
          const overlapX =
            Math.min(first.rect.right, second.rect.right) -
            Math.max(first.rect.left, second.rect.left);
          const overlapY =
            Math.min(first.rect.bottom, second.rect.bottom) -
            Math.max(first.rect.top, second.rect.top);
          const isOverlap =
            overlapX > CONTROL_COLLISION_OVERLAP_TOLERANCE_PX &&
            overlapY > CONTROL_COLLISION_OVERLAP_TOLERANCE_PX;
          if (isOverlap) {
            // Password visibility toggles, clear buttons, and similar embedded
            // field actions are positioned over reserved input padding. Keep
            // ordinary same-parent controls actionable, but do not call this
            // deliberate positioned composition a collision.
            if (
              first.element.parentElement === second.element.parentElement &&
              (first.positioned || second.positioned)
            ) {
              continue;
            }
            const axis = overlapY <= overlapX ? "vertical" : "horizontal";
            reportScanIssue(
              first.element,
              BEACON_SIGNAL.CONTROL_COLLISION,
              `Control collision — ${describeElement(first.element)} overlaps ${describeElement(second.element)}`,
              {
                collidesWith: describeElement(second.element),
                collisionAxis: axis,
                collisionKind: "overlap",
                overlapPx: String(
                  Math.round(axis === "vertical" ? overlapY : overlapX),
                ),
              },
            );
            continue;
          }

          // Zero-spacing is common and intentional inside segmented controls,
          // navs, and same-parent button rows. It is suspicious when separate
          // layout groups collapse into each other, as in a panel footer laid
          // directly against the preceding action row.
          if (
            first.element.parentElement === second.element.parentElement ||
            sharedIntentionalControlGroup(first.element, second.element) ||
            first.positioned ||
            second.positioned
          ) {
            continue;
          }
          const firstWidth = first.rect.right - first.rect.left;
          const secondWidth = second.rect.right - second.rect.left;
          const firstHeight = first.rect.bottom - first.rect.top;
          const secondHeight = second.rect.bottom - second.rect.top;
          const horizontalGap = Math.max(
            first.rect.left - second.rect.right,
            second.rect.left - first.rect.right,
            0,
          );
          const verticalGap = Math.max(
            first.rect.top - second.rect.bottom,
            second.rect.top - first.rect.bottom,
            0,
          );
          const horizontalOverlapRatio =
            Math.max(overlapX, 0) / Math.min(firstWidth, secondWidth);
          const verticalOverlapRatio =
            Math.max(overlapY, 0) / Math.min(firstHeight, secondHeight);
          const verticalTouch =
            verticalGap <= controlCollisionGapPx &&
            horizontalOverlapRatio >= CONTROL_COLLISION_MIN_CROSS_AXIS_RATIO;
          const horizontalTouch =
            horizontalGap <= controlCollisionGapPx &&
            verticalOverlapRatio >= CONTROL_COLLISION_MIN_CROSS_AXIS_RATIO;
          if (!verticalTouch && !horizontalTouch) continue;
          const axis = verticalTouch ? "vertical" : "horizontal";
          reportScanIssue(
            first.element,
            BEACON_SIGNAL.CONTROL_COLLISION,
            `Control collision — ${describeElement(first.element)} touches ${describeElement(second.element)}`,
            {
              collidesWith: describeElement(second.element),
              collisionAxis: axis,
              collisionKind: "touching",
              gapPx: String(
                Math.round(axis === "vertical" ? verticalGap : horizontalGap),
              ),
            },
          );
        }
      }
    };

    const scanForOcclusion = (): void => {
      if (typeof document.elementFromPoint !== "function") return;
      // While an overlay owns the page, covering the rest of it is the point.
      if (viewportCoveredByOverlay()) return;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const controls = document.querySelectorAll(CONTROL_SELECTOR);
      let sampled = 0;
      for (const control of Array.from(controls)) {
        if (sampled >= OCCLUSION_SAMPLE_LIMIT) return;
        if (isScanExempt(control) || hasHiddenAncestor(control, true)) continue;
        const rect = control.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const visibleRect = visibleControlRect(
          control,
          rect,
          viewportWidth,
          viewportHeight,
        );
        if (visibleRect === null) continue;
        sampled += 1;
        const top = document.elementFromPoint(
          (visibleRect.left + visibleRect.right) / 2,
          (visibleRect.top + visibleRect.bottom) / 2,
        );
        if (
          top === null ||
          top === control ||
          control.contains(top) ||
          top.contains(control) ||
          // A non-modal dialog/popover intentionally paints across the page
          // beneath it. Controls remain actionable inside that surface; the
          // covered page is not evidence that either side is broken.
          crossesDialogBoundary(control, top) ||
          // Browser extensions may inject their own UI above the document.
          // The application cannot repair or safely attribute that occlusion.
          isExtensionOwnedCover(top)
        ) {
          continue;
        }
        const topRect = top.getBoundingClientRect();
        const overlapX =
          Math.min(visibleRect.right, topRect.right) -
          Math.max(visibleRect.left, topRect.left);
        const overlapY =
          Math.min(visibleRect.bottom, topRect.bottom) -
          Math.max(visibleRect.top, topRect.top);
        const coverage =
          (Math.max(overlapX, 0) * Math.max(overlapY, 0)) /
          ((visibleRect.right - visibleRect.left) *
            (visibleRect.bottom - visibleRect.top));
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
    type ParsedColor = { r: number; g: number; b: number; a: number };
    const clamp = (value: number, min: number, max: number): number =>
      Math.min(Math.max(value, min), max);
    const parseAlpha = (value: string | undefined): number => {
      if (value === undefined) return 1;
      const parsed = Number.parseFloat(value);

      return clamp(value.endsWith("%") ? parsed / 100 : parsed, 0, 1);
    };
    const parseRgbColor = (value: string): ParsedColor | null => {
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
    // Chromium preserves CSS Color 4 values such as Tailwind v4's oklch()
    // palette in getComputedStyle(). Convert them to sRGB before contrast
    // math; treating an unparsed opaque background as transparent makes the
    // scanner walk to a white ancestor and report false white-on-white text.
    const parseOklchColor = (value: string): ParsedColor | null => {
      const match =
        /^oklch\(\s*([\d.]+)(%)?\s+([\d.]+)\s+(-?[\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/u.exec(
          value,
        );
      if (match === null) return null;
      const lightness = Number(match[1]) / (match[2] === "%" ? 100 : 1);
      const chroma = Number(match[3]);
      const hue = (Number(match[4]) * Math.PI) / 180;
      const a = chroma * Math.cos(hue);
      const b = chroma * Math.sin(hue);
      const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
      const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
      const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
      const l = lRoot ** 3;
      const m = mRoot ** 3;
      const s = sRoot ** 3;
      const linearToSrgb = (channel: number): number => {
        const encoded =
          channel <= 0.0031308
            ? 12.92 * channel
            : 1.055 * channel ** (1 / 2.4) - 0.055;

        return clamp(encoded, 0, 1) * 255;
      };

      return {
        a: parseAlpha(match[5]),
        b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
        g: linearToSrgb(
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        ),
        r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      };
    };
    let colorCanvasContext: CanvasRenderingContext2D | null | undefined;
    const parseBrowserColor = (value: string): ParsedColor | null => {
      try {
        if (colorCanvasContext === undefined) {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          colorCanvasContext = canvas.getContext("2d", {
            colorSpace: "srgb",
            willReadFrequently: true,
          });
        }
        const context = colorCanvasContext;
        if (context === null) return null;

        // Canvas ignores an invalid assignment and retains its previous color.
        // Seed a value that computed styles will not use, then let the browser
        // convert every color space it supports into the sRGB pixel WCAG needs.
        context.fillStyle = "#010203";
        const sentinel = context.fillStyle;
        context.fillStyle = value;
        if (context.fillStyle === sentinel) return null;
        context.clearRect(0, 0, 1, 1);
        context.fillRect(0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;

        return {
          a: (pixel[3] ?? 0) / 255,
          b: pixel[2] ?? 0,
          g: pixel[1] ?? 0,
          r: pixel[0] ?? 0,
        };
      } catch {
        colorCanvasContext = null;

        return null;
      }
    };
    const parseColor = (value: string): ParsedColor | null => {
      if (value === "" || value === "transparent") {
        return { a: 0, b: 0, g: 0, r: 0 };
      }

      return (
        parseRgbColor(value) ??
        parseOklchColor(value) ??
        parseBrowserColor(value)
      );
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
        if (background === null) return null;
        if (background.a > 0) {
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

    // Only explicitly adaptive subtrees participate. Without that contract an
    // intentional inverted hero is indistinguishable from a missed theme.
    const activeTheme = (): "dark" | "light" | null => {
      const root = document.documentElement;
      const declared = window.getComputedStyle(root).colorScheme.trim();
      if (declared === "dark") return "dark";
      if (declared === "light") return "light";
      const dataTheme = root.getAttribute("data-theme");
      if (dataTheme === "dark" || dataTheme === "light") return dataTheme;
      if (root.classList.contains("dark")) return "dark";

      return null;
    };
    const scanForThemeMismatch = (): void => {
      const theme = activeTheme();
      if (theme === null) return;
      const roots = document.querySelectorAll(
        `[${BEACON_ATTRIBUTE.THEME}="adaptive"]`,
      );
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      let sampled = 0;
      for (const root of Array.from(roots)) {
        const candidates = [root, ...Array.from(root.querySelectorAll("*"))];
        for (const element of candidates) {
          if (sampled >= THEME_SURFACE_SAMPLE_LIMIT) return;
          if (
            element.closest(`[${BEACON_ATTRIBUTE.THEME}="allow"]`) !== null ||
            isScanExempt(element) ||
            element.matches("canvas, iframe, img, picture, svg, video")
          ) {
            continue;
          }
          const rect = element.getBoundingClientRect();
          const minimumArea = element.matches(CONTROL_SELECTOR)
            ? themeMismatchControlMinArea
            : themeMismatchMinArea;
          if (rect.width * rect.height < minimumArea) continue;
          if (
            rect.bottom < 0 ||
            rect.top > viewportHeight ||
            rect.right < 0 ||
            rect.left > viewportWidth
          ) {
            continue;
          }
          const hasContent =
            (element.textContent ?? "").trim() !== "" ||
            element.querySelector(
              "button, input, select, textarea, [role=button]",
            ) !== null;
          if (!hasContent) continue;
          const style = window.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            (style.backgroundImage !== "none" && style.backgroundImage !== "")
          ) {
            continue;
          }
          const surface = parseColor(style.backgroundColor);
          if (surface === null || surface.a < 0.95) continue;
          sampled += 1;
          const luminance = relativeLuminance(surface);
          const opposite =
            theme === "dark"
              ? luminance >= THEME_LIGHT_SURFACE_LUMINANCE_MIN
              : luminance <= THEME_DARK_SURFACE_LUMINANCE_MAX;
          if (!opposite) continue;
          reportScanIssue(
            element,
            BEACON_SIGNAL.THEME_MISMATCH,
            `Theme mismatch — ${describeElement(element)} renders an opposite-polarity surface in ${theme} mode`,
            {
              activeTheme: theme,
              area: String(Math.round(rect.width * rect.height)),
              surfaceColor: style.backgroundColor,
              surfaceLuminance: luminance.toFixed(3),
            },
          );
        }
      }
    };

    // — stuck loading: first-seen timestamps survive across scans; a slow
    //   poll catches spinners that hang while the user does nothing at all.
    const loadingFirstSeen = new WeakMap<Element, number>();
    const reportedStuckLoading = new WeakSet<Element>();
    const trackedLoadingIndicators = new Set<Element>();
    let lastLoadingCheckAt: number | undefined;
    const loadingIndicatorSelector = `[aria-busy="true"], [role="progressbar"], [${BEACON_ATTRIBUTE.LOADING}]`;
    const resetLoadingIndicator = (indicator: Element): void => {
      loadingFirstSeen.delete(indicator);
      reportedStuckLoading.delete(indicator);
      trackedLoadingIndicators.delete(indicator);
    };
    const loadingLifecycleObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (!(record.target instanceof Element)) continue;
        // A persistent control can resolve and enter a later loading cycle
        // between the five-second polls. Its old first-seen/report state must
        // not leak into that new operation.
        resetLoadingIndicator(record.target);
      }
    });
    loadingLifecycleObserver.observe(document.documentElement, {
      attributeFilter: [
        "aria-busy",
        "role",
        BEACON_ATTRIBUTE.LOADING,
        BEACON_ATTRIBUTE.LOADING_TIMEOUT,
      ],
      attributes: true,
      subtree: true,
    });
    cleanups.push(() => loadingLifecycleObserver.disconnect());
    const isPersistentDeterminateProgress = (indicator: Element): boolean =>
      indicator.getAttribute("role") === "progressbar" &&
      indicator.hasAttribute("aria-valuenow") &&
      indicator.getAttribute("aria-busy") !== "true" &&
      !indicator.hasAttribute(BEACON_ATTRIBUTE.LOADING);
    const hasTrackedLoadingAncestor = (indicator: Element): boolean => {
      let ancestor = indicator.parentElement?.closest(loadingIndicatorSelector);
      while (ancestor !== null && ancestor !== undefined) {
        if (
          !isPersistentDeterminateProgress(ancestor) &&
          !isScanExempt(ancestor) &&
          !hasHiddenAncestor(ancestor)
        ) {
          return true;
        }
        ancestor = ancestor.parentElement?.closest(loadingIndicatorSelector);
      }

      return false;
    };
    const loadingDeadlineMs = (indicator: Element): number => {
      const configured = indicator
        .getAttribute(BEACON_ATTRIBUTE.LOADING_TIMEOUT)
        ?.trim();
      if (!configured) return stuckLoadingMs;
      const parsed = Number(configured);

      return Number.isSafeInteger(parsed) && parsed >= 0
        ? parsed
        : stuckLoadingMs;
    };
    const checkStuckLoading = (): void => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      const missedPollWindow =
        lastLoadingCheckAt !== undefined &&
        now - lastLoadingCheckAt > STUCK_LOADING_POLL_MS * 3;
      lastLoadingCheckAt = now;
      const indicators = Array.from(
        document.querySelectorAll(loadingIndicatorSelector),
      );
      const activeIndicators = new Set(indicators);
      for (const tracked of trackedLoadingIndicators) {
        if (!activeIndicators.has(tracked)) resetLoadingIndicator(tracked);
      }
      for (const indicator of indicators) {
        if (
          isPersistentDeterminateProgress(indicator) ||
          isScanExempt(indicator) ||
          hasHiddenAncestor(indicator) ||
          hasTrackedLoadingAncestor(indicator)
        ) {
          resetLoadingIndicator(indicator);
          continue;
        }
        const rect = indicator.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          resetLoadingIndicator(indicator);
          continue;
        }
        if (missedPollWindow && loadingFirstSeen.has(indicator)) {
          // A background tab, sleeping device, or blocked event loop can miss
          // many polls. Wall-clock time during that blind window is not proof
          // the loading UI stayed visible and interactive; restart its visible
          // deadline now that observation has resumed.
          loadingFirstSeen.set(indicator, now);
        }
        const firstSeen = loadingFirstSeen.get(indicator);
        if (firstSeen === undefined) {
          loadingFirstSeen.set(indicator, now);
          trackedLoadingIndicators.add(indicator);
          continue;
        }
        const deadlineMs = loadingDeadlineMs(indicator);
        if (
          now - firstSeen < deadlineMs ||
          reportedStuckLoading.has(indicator)
        ) {
          continue;
        }
        reportedStuckLoading.add(indicator);
        reportScanIssue(
          indicator,
          BEACON_SIGNAL.STUCK_LOADING,
          `Stuck loading — ${describeElement(indicator)} never resolved`,
          {
            deadlineMs: String(deadlineMs),
            visibleMs: String(now - firstSeen),
          },
        );
      }
    };

    const checkBlankAppRoots = (): void => {
      if (document.visibilityState === "hidden") return;
      const roots = document.querySelectorAll(`[${BEACON_ATTRIBUTE.APP_ROOT}]`);
      for (const root of Array.from(roots)) {
        if (isScanExempt(root)) continue;
        const rect = root.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = (root.textContent ?? "").trim();
        const meaningful =
          text !== "" ||
          root.querySelector(
            "button, input, select, textarea, img, svg, canvas, video, iframe, [role=alert]",
          ) !== null;
        const loading =
          root.querySelector(
            `[aria-busy="true"], [role="progressbar"], [${BEACON_ATTRIBUTE.LOADING}]`,
          ) !== null;
        if (meaningful || loading) continue;
        const name =
          root.getAttribute(BEACON_ATTRIBUTE.APP_ROOT)?.trim() ||
          describeElement(root);
        reportScanIssue(
          root,
          BEACON_SIGNAL.BLANK_APP_ROOT,
          `Blank application root — ${name} rendered no meaningful content`,
          {},
        );
      }
    };

    const documentStylesAreReady = (): boolean => {
      const stylesheets = Array.from(
        document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'),
      ).filter((link) => {
        if (link.disabled) return false;
        const media = link.media.trim();

        return (
          media === "" ||
          typeof window.matchMedia !== "function" ||
          window.matchMedia(media).matches
        );
      });

      return stylesheets.every((link) => link.sheet !== null);
    };

    const runSettledScan = (): void => {
      // Geometry and computed colors are meaningless while an active
      // stylesheet failed to attach. Resource instrumentation owns that
      // failure; emitting dozens of collisions from the unstyled fallback DOM
      // would hide the single actionable cause.
      const visualStylesReady = documentStylesAreReady();
      if (detectOverflow && visualStylesReady) scanForOverflow();
      if (detectControlCollision && visualStylesReady)
        scanForControlCollisions();
      if (detectOcclusion && visualStylesReady) scanForOcclusion();
      if (detectInvisibleText && visualStylesReady) scanForInvisibleText();
      if (detectThemeMismatch && visualStylesReady) scanForThemeMismatch();
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
    const themeObserver = new MutationObserver(scheduleOverflowScan);
    themeObserver.observe(document.documentElement, {
      attributeFilter: ["class", "data-theme", "style"],
      attributes: true,
    });
    overflowScanOnNavigation = scheduleOverflowScan;
    cleanups.push(() => {
      window.removeEventListener("resize", scheduleOverflowScan);
      themeObserver.disconnect();
      overflowScanOnNavigation = null;
      if (overflowTimer !== undefined) clearTimeout(overflowTimer);
    });
    if (detectStuckLoading) {
      const stuckTimer = setInterval(checkStuckLoading, STUCK_LOADING_POLL_MS);
      (stuckTimer as { unref?: () => void }).unref?.();
      cleanups.push(() => clearInterval(stuckTimer));
    }
    if (detectBlankAppRoot) {
      const blankTimer = setTimeout(
        checkBlankAppRoots,
        signals.blankAppRootSettleMs ?? BLANK_APP_ROOT_SETTLE_DEFAULT_MS,
      );
      cleanups.push(() => clearTimeout(blankTimer));
    }
  }

  if (
    signals !== null &&
    signals.disruptiveLayoutShifts !== false &&
    typeof PerformanceObserver !== "undefined"
  ) {
    const minimum =
      signals.disruptiveLayoutShiftMin ?? DISRUPTIVE_LAYOUT_SHIFT_DEFAULT_MIN;
    const reported = new Set<string>();
    let viewportResizeTimes: number[] = [];
    const recordViewportResize = (): void => {
      viewportResizeTimes.push(performance.now());
      if (viewportResizeTimes.length > VIEWPORT_RESIZE_HISTORY_LIMIT) {
        viewportResizeTimes = viewportResizeTimes.slice(
          -VIEWPORT_RESIZE_HISTORY_LIMIT,
        );
      }
    };
    window.addEventListener("resize", recordViewportResize);
    window.visualViewport?.addEventListener("resize", recordViewportResize);
    try {
      const observer = new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const entry = raw as PerformanceEntry & {
            hadRecentInput?: boolean;
            sources?: Array<{ node?: Node | null }>;
            value?: number;
          };
          const interactionAgeMs =
            recentInteraction === undefined
              ? undefined
              : entry.startTime - recentInteraction.performanceAt;
          const beaconSawRecentInput =
            interactionAgeMs !== undefined &&
            interactionAgeMs >= 0 &&
            interactionAgeMs <= LAYOUT_SHIFT_RECENT_INTERACTION_MS;
          const resizeAdjacent = viewportResizeTimes.some((resizedAt) => {
            const resizeAgeMs = entry.startTime - resizedAt;
            return (
              resizeAgeMs >= 0 &&
              resizeAgeMs <= LAYOUT_SHIFT_VIEWPORT_RESIZE_SETTLE_MS
            );
          });
          if (
            entry.hadRecentInput === true ||
            beaconSawRecentInput ||
            resizeAdjacent ||
            mobileKeyboardViewportActive() ||
            (entry.value ?? 0) < minimum
          )
            continue;
          const targets = (entry.sources ?? [])
            .map(({ node }) =>
              node instanceof Element ? describeElement(node) : undefined,
            )
            .filter((target): target is string => target !== undefined)
            .slice(0, 5);
          const key = targets.join(",") || "unknown";
          if (reported.has(key)) continue;
          reported.add(key);
          emitSignal(
            `Disruptive layout shift — ${key} — ${shortUrl(location.href)}`,
            {
              shiftValue: String(entry.value ?? 0),
              signal: BEACON_SIGNAL.DISRUPTIVE_LAYOUT_SHIFT,
              target: key,
            },
          );
        }
      });
      observer.observe({ buffered: true, type: "layout-shift" });
      cleanups.push(() => {
        observer.disconnect();
        window.removeEventListener("resize", recordViewportResize);
        window.visualViewport?.removeEventListener(
          "resize",
          recordViewportResize,
        );
      });
    } catch {
      window.removeEventListener("resize", recordViewportResize);
      window.visualViewport?.removeEventListener(
        "resize",
        recordViewportResize,
      );
      // Layout Instability API unsupported.
    }
  }

  if (
    signals !== null &&
    signals.slowInteractions !== false &&
    typeof PerformanceObserver !== "undefined"
  ) {
    const minimum = signals.slowInteractionMs ?? SLOW_INTERACTION_DEFAULT_MS;
    const reported = new Set<number>();
    type BlockingFrame = PerformanceEntry & {
      blockingDuration?: number;
      scripts?: Array<{
        duration?: number;
        functionName?: string;
        invoker?: string;
        sourceURL?: string;
      }>;
    };
    const blockingFrames: BlockingFrame[] = [];
    const recordBlockingFrames = (entries: PerformanceEntry[]): void => {
      for (const entry of entries) blockingFrames.push(entry as BlockingFrame);
      if (blockingFrames.length > 50)
        blockingFrames.splice(0, blockingFrames.length - 50);
    };
    let blockingObserver: PerformanceObserver | undefined;
    try {
      blockingObserver = new PerformanceObserver((list) => {
        recordBlockingFrames(list.getEntries());
      });
      const supportedTypes = PerformanceObserver.supportedEntryTypes;
      if (supportedTypes?.includes("long-animation-frame")) {
        blockingObserver.observe({
          buffered: true,
          type: "long-animation-frame",
        });
      } else if (supportedTypes?.includes("longtask")) {
        blockingObserver.observe({ buffered: true, type: "longtask" });
      } else if (supportedTypes === undefined || supportedTypes.length === 0) {
        blockingObserver.observe({
          buffered: true,
          type: "long-animation-frame",
        });
      } else {
        blockingObserver.disconnect();
        blockingObserver = undefined;
      }
      if (blockingObserver !== undefined) {
        cleanups.push(() => blockingObserver?.disconnect());
      }
    } catch {
      blockingObserver?.disconnect();
      blockingObserver = undefined;
    }
    try {
      const observer = new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const entry = raw as PerformanceEntry & {
            interactionId?: number;
            processingEnd?: number;
            processingStart?: number;
            target?: Node | null;
          };
          if (
            entry.duration < minimum ||
            entry.interactionId === undefined ||
            entry.interactionId <= 0
          )
            continue;
          const target =
            entry.target instanceof Element
              ? describeElement(entry.target)
              : "unknown";
          const key = entry.interactionId;
          if (reported.has(key)) continue;
          reported.add(key);
          if (blockingObserver !== undefined) {
            recordBlockingFrames(blockingObserver.takeRecords());
          }
          const interactionEnd = entry.startTime + entry.duration;
          const overlappingFrame = blockingFrames
            .filter(
              (frame) =>
                frame.startTime < interactionEnd &&
                frame.startTime + frame.duration > entry.startTime,
            )
            .sort((left, right) => {
              const leftBlocking =
                left.blockingDuration ??
                Math.max(0, left.duration - LONG_TASK_MS);
              const rightBlocking =
                right.blockingDuration ??
                Math.max(0, right.duration - LONG_TASK_MS);
              return rightBlocking - leftBlocking;
            })[0];
          const script = [...(overlappingFrame?.scripts ?? [])].sort(
            (left, right) => (right.duration ?? 0) - (left.duration ?? 0),
          )[0];
          const hasPhaseTiming =
            typeof entry.processingStart === "number" &&
            typeof entry.processingEnd === "number";
          const processingDurationMs = hasPhaseTiming
            ? Math.round(
                Math.max(0, entry.processingEnd! - entry.processingStart!),
              )
            : undefined;
          const presentationDelayMs = hasPhaseTiming
            ? Math.round(Math.max(0, interactionEnd - entry.processingEnd!))
            : undefined;
          // A detached/removed Event Timing target with no blocking frame and
          // effectively no handler work leaves only browser presentation time.
          // Web-vitals still retains the aggregate INP sample; do not promote
          // that unfixable sample to an issue. Preserve targetless entries when
          // a blocking frame or meaningful application processing remains.
          if (
            target === "unknown" &&
            overlappingFrame === undefined &&
            processingDurationMs !== undefined &&
            processingDurationMs <= 16 &&
            presentationDelayMs !== undefined &&
            presentationDelayMs >= minimum
          )
            continue;
          emitSignal(
            `Slow interaction — ${entry.name} took ${Math.round(entry.duration)}ms — ${shortUrl(location.href)}`,
            {
              ...(hasPhaseTiming
                ? {
                    inputDelayMs: String(
                      Math.round(
                        Math.max(0, entry.processingStart! - entry.startTime),
                      ),
                    ),
                    presentationDelayMs: String(presentationDelayMs),
                    processingDurationMs: String(processingDurationMs),
                  }
                : { phaseAttribution: "unavailable" }),
              ...(overlappingFrame === undefined
                ? { blockingFrameAttribution: "not-observed" }
                : {
                    blockingDurationMs: String(
                      Math.round(
                        overlappingFrame.blockingDuration ??
                          Math.max(0, overlappingFrame.duration - LONG_TASK_MS),
                      ),
                    ),
                    blockingEntryType: overlappingFrame.entryType,
                    blockingFrameDurationMs: String(
                      Math.round(overlappingFrame.duration),
                    ),
                  }),
              durationMs: String(Math.round(entry.duration)),
              eventType: entry.name,
              interactionId: String(entry.interactionId),
              ...(script?.functionName === undefined
                ? {}
                : { scriptFunction: script.functionName }),
              ...(script?.invoker === undefined
                ? {}
                : { scriptInvoker: script.invoker }),
              ...(script?.sourceURL === undefined
                ? {}
                : { scriptSource: shortUrl(script.sourceURL) }),
              signal: BEACON_SIGNAL.SLOW_INTERACTION,
              target,
            },
          );
        }
      });
      observer.observe({
        buffered: true,
        durationThreshold: Math.max(16, Math.min(1040, minimum)),
        type: "event",
      });
      cleanups.push(() => observer.disconnect());
    } catch {
      // Event Timing API unsupported.
    }
  }

  if (
    signals !== null &&
    signals.slowResources !== false &&
    typeof PerformanceObserver !== "undefined"
  ) {
    const minimum = signals.slowResourceMs ?? SLOW_RESOURCE_DEFAULT_MS;
    const reported = new Set<string>();
    try {
      const observer = new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const entry = raw as PerformanceResourceTiming;
          if (entry.duration < minimum) continue;
          if (!/^(css|font|img|link|script)$/u.test(entry.initiatorType))
            continue;
          const resource = shortUrl(entry.name);
          const key = `${entry.initiatorType}|${resource}`;
          if (reported.has(key)) continue;
          reported.add(key);
          emitSignal(`Slow resource — ${entry.initiatorType} ${resource}`, {
            cacheHit: String(entry.transferSize === 0),
            durationMs: String(Math.round(entry.duration)),
            initiatorType: entry.initiatorType,
            protocol: entry.nextHopProtocol || "unknown",
            signal: BEACON_SIGNAL.SLOW_RESOURCE,
            target: resource,
            transferSize: String(entry.transferSize),
          });
        }
      });
      observer.observe({ buffered: true, type: "resource" });
      cleanups.push(() => observer.disconnect());
    } catch {
      // Resource Timing observer unsupported.
    }
  }

  // Opt-in embedded content watchdog. Cross-origin error documents can still
  // dispatch `load`, so the only generic claim Beacon makes is the defensible
  // one: a marked, visible iframe never loaded at all.
  if (
    signals !== null &&
    signals.embeddedContentStalls !== false &&
    typeof document !== "undefined"
  ) {
    const stallMs =
      signals.embeddedContentStallMs ?? EMBEDDED_CONTENT_STALL_DEFAULT_MS;
    const watched = new Map<
      HTMLIFrameElement,
      { onLoad: () => void; timer: ReturnType<typeof setTimeout> }
    >();
    const stopWatching = (frame: HTMLIFrameElement): void => {
      const state = watched.get(frame);
      if (state === undefined) return;
      clearTimeout(state.timer);
      frame.removeEventListener("load", state.onLoad);
      watched.delete(frame);
    };
    const watchFrame = (frame: HTMLIFrameElement): void => {
      stopWatching(frame);
      const name = frame.getAttribute(BEACON_ATTRIBUTE.EMBED);
      if (name === null) return;
      const onLoad = (): void => stopWatching(frame);
      const timer = setTimeout(() => {
        stopWatching(frame);
        if (
          pageLifecycleEnding ||
          document.visibilityState === "hidden" ||
          !frame.isConnected
        ) {
          return;
        }
        const rect = frame.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const source = frame.getAttribute("src") ?? "";
        emitSignal(
          `Embedded content stalled — ${describeElement(frame)} never loaded — ${shortUrl(location.href)}`,
          {
            embed: name.slice(0, 64),
            elapsedMs: String(stallMs),
            signal: BEACON_SIGNAL.EMBEDDED_CONTENT_STALLED,
            sourcePath: shortUrl(source),
            target: describeElement(frame),
          },
        );
      }, stallMs);
      watched.set(frame, { onLoad, timer });
      frame.addEventListener("load", onLoad, { once: true });
    };
    const discoverFrames = (root: ParentNode): void => {
      if (
        root instanceof HTMLIFrameElement &&
        root.hasAttribute(BEACON_ATTRIBUTE.EMBED)
      ) {
        watchFrame(root);
      }
      for (const frame of Array.from(
        root.querySelectorAll<HTMLIFrameElement>(
          `iframe[${BEACON_ATTRIBUTE.EMBED}]`,
        ),
      )) {
        watchFrame(frame);
      }
    };
    discoverFrames(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.target instanceof HTMLIFrameElement) {
            watchFrame(record.target);
          }
          continue;
        }
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) discoverFrames(node);
        }
        for (const node of Array.from(record.removedNodes)) {
          if (node instanceof HTMLIFrameElement) stopWatching(node);
          if (node instanceof Element) {
            for (const frame of Array.from(node.querySelectorAll("iframe"))) {
              stopWatching(frame);
            }
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      attributeFilter: [BEACON_ATTRIBUTE.EMBED, "src"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    cleanups.push(() => {
      observer.disconnect();
      for (const frame of Array.from(watched.keys())) stopWatching(frame);
    });
  }

  if (
    signals !== null &&
    signals.mediaFailures !== false &&
    typeof document !== "undefined"
  ) {
    const stallMs = signals.mediaStallMs ?? MEDIA_STALL_DEFAULT_MS;
    const watched = new Map<
      HTMLMediaElement,
      { cleanup: () => void; stallTimer?: ReturnType<typeof setTimeout> }
    >();
    const watch = (media: HTMLMediaElement): void => {
      if (watched.has(media) || !media.hasAttribute(BEACON_ATTRIBUTE.MEDIA))
        return;
      const name =
        media.getAttribute(BEACON_ATTRIBUTE.MEDIA)?.trim() ||
        describeElement(media);
      let started = false;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const clearStall = (): void => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        stallTimer = undefined;
      };
      const onPlay = (): void => {
        started = true;
        clearStall();
      };
      const onWaiting = (): void => {
        if (!started || media.ended || media.paused) return;
        clearStall();
        stallTimer = setTimeout(() => {
          if (!media.isConnected || media.ended || media.paused) return;
          emitSignal(
            `Media playback stalled — ${name} — ${shortUrl(location.href)}`,
            {
              currentTime: String(Math.round(media.currentTime)),
              networkState: String(media.networkState),
              readyState: String(media.readyState),
              signal: BEACON_SIGNAL.MEDIA_PLAYBACK_STALLED,
              target: name,
            },
          );
        }, stallMs);
      };
      const onError = (): void => {
        const error = media.error;
        emitSignal(
          `Media playback failed — ${name} — ${shortUrl(location.href)}`,
          {
            errorCode: String(error?.code ?? 0),
            networkState: String(media.networkState),
            signal: BEACON_SIGNAL.MEDIA_PLAYBACK_FAILED,
            target: name,
          },
        );
      };
      media.addEventListener("playing", onPlay);
      media.addEventListener("waiting", onWaiting);
      media.addEventListener("stalled", onWaiting);
      media.addEventListener("waitingforkey", onWaiting);
      media.addEventListener("error", onError);
      media.addEventListener("pause", clearStall);
      media.addEventListener("ended", clearStall);
      const cleanup = (): void => {
        clearStall();
        media.removeEventListener("playing", onPlay);
        media.removeEventListener("waiting", onWaiting);
        media.removeEventListener("stalled", onWaiting);
        media.removeEventListener("waitingforkey", onWaiting);
        media.removeEventListener("error", onError);
        media.removeEventListener("pause", clearStall);
        media.removeEventListener("ended", clearStall);
      };
      watched.set(media, { cleanup, stallTimer });
    };
    const scan = (root: ParentNode): void => {
      if (root instanceof HTMLMediaElement) watch(root);
      for (const media of Array.from(
        root.querySelectorAll?.(
          `audio[${BEACON_ATTRIBUTE.MEDIA}], video[${BEACON_ATTRIBUTE.MEDIA}]`,
        ) ?? [],
      )) {
        if (media instanceof HTMLMediaElement) watch(media);
      }
    };
    scan(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) scan(node);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    cleanups.push(() => {
      observer.disconnect();
      for (const { cleanup } of watched.values()) cleanup();
      watched.clear();
    });
  }

  if (
    signals !== null &&
    signals.storageFailures !== false &&
    typeof Storage !== "undefined"
  ) {
    const originalSetItem = Storage.prototype.setItem;
    const wrappedSetItem = function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      try {
        originalSetItem.call(this, key, value);
      } catch (error) {
        const resolved = toError(error);
        emitSignal(
          `Browser storage failure — ${resolved.name} — ${shortUrl(location.href)}`,
          {
            errorName: resolved.name,
            signal: BEACON_SIGNAL.STORAGE_FAILURE,
            storage: this === localStorage ? "localStorage" : "sessionStorage",
          },
        );
        throw error;
      }
    };
    try {
      Storage.prototype.setItem = wrappedSetItem;
      cleanups.push(() => {
        Storage.prototype.setItem = originalSetItem;
      });
    } catch {
      // Storage prototype may be immutable in embedded browser hosts.
    }
  }

  if (
    signals !== null &&
    signals.storageFailures !== false &&
    typeof indexedDB !== "undefined"
  ) {
    const factory = indexedDB;
    const originalOpen = factory.open.bind(factory);
    const originalDeleteDatabase = factory.deleteDatabase.bind(factory);
    const reported = new WeakSet<IDBRequest>();
    const watch = <T extends IDBRequest>(
      request: T,
      operation: "open" | "delete",
      database: string,
    ): T => {
      request.addEventListener(
        "error",
        () => {
          if (reported.has(request)) return;
          reported.add(request);
          const error = request.error;
          emitSignal(
            `IndexedDB ${operation} failure — ${error?.name ?? "UnknownError"} — ${shortUrl(location.href)}`,
            {
              database: database.slice(0, SIGNAL_TEXT_MAX),
              errorName: error?.name ?? "UnknownError",
              operation,
              signal: BEACON_SIGNAL.STORAGE_FAILURE,
              storage: "indexedDB",
            },
          );
        },
        { once: true },
      );

      return request;
    };
    const wrappedOpen = ((name: string, version?: number) =>
      watch(
        version === undefined
          ? originalOpen(name)
          : originalOpen(name, version),
        "open",
        name,
      )) as IDBFactory["open"];
    const wrappedDeleteDatabase = ((name: string) =>
      watch(
        originalDeleteDatabase(name),
        "delete",
        name,
      )) as IDBFactory["deleteDatabase"];
    try {
      factory.open = wrappedOpen;
      factory.deleteDatabase = wrappedDeleteDatabase;
      cleanups.push(() => {
        if (factory.open === wrappedOpen) factory.open = originalOpen;
        if (factory.deleteDatabase === wrappedDeleteDatabase) {
          factory.deleteDatabase = originalDeleteDatabase;
        }
      });
    } catch {
      // Some browsers expose a non-writable IDBFactory instance.
    }
  }

  if (
    signals !== null &&
    signals.webglContextLosses !== false &&
    typeof document !== "undefined"
  ) {
    const graceMs =
      signals.webglRestoreGraceMs ?? WEBGL_RESTORE_GRACE_DEFAULT_MS;
    const pending = new Map<HTMLCanvasElement, ReturnType<typeof setTimeout>>();
    const reported = new WeakSet<HTMLCanvasElement>();
    const clearPending = (canvas: HTMLCanvasElement): void => {
      const timer = pending.get(canvas);
      if (timer !== undefined) clearTimeout(timer);
      pending.delete(canvas);
    };
    const onLost = (event: Event): void => {
      if (!(event.target instanceof HTMLCanvasElement)) return;
      const canvas = event.target;
      clearPending(canvas);
      const timer = setTimeout(() => {
        pending.delete(canvas);
        if (
          reported.has(canvas) ||
          pageLifecycleEnding ||
          document.visibilityState === "hidden" ||
          !canvas.isConnected
        ) {
          return;
        }
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        reported.add(canvas);
        emitSignal(
          `WebGL context lost — ${describeElement(canvas)} did not restore — ${shortUrl(location.href)}`,
          {
            canvasHeight: String(canvas.height),
            canvasWidth: String(canvas.width),
            graceMs: String(graceMs),
            signal: BEACON_SIGNAL.WEBGL_CONTEXT_LOST,
            target: describeElement(canvas),
          },
        );
      }, graceMs);
      pending.set(canvas, timer);
    };
    const onRestored = (event: Event): void => {
      if (event.target instanceof HTMLCanvasElement) clearPending(event.target);
    };
    document.addEventListener("webglcontextlost", onLost, true);
    document.addEventListener("webglcontextrestored", onRestored, true);
    cleanups.push(() => {
      document.removeEventListener("webglcontextlost", onLost, true);
      document.removeEventListener("webglcontextrestored", onRestored, true);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    });
  }

  // ——— Interaction watchdogs ———————————————————————————————————————————
  if (signals !== null && typeof document !== "undefined") {
    if (
      signals.focusedControlsOffscreen !== false &&
      window.visualViewport !== undefined &&
      window.visualViewport !== null
    ) {
      const visualViewport = window.visualViewport;
      const settleMs =
        signals.focusedControlSettleMs ?? FOCUSED_CONTROL_SETTLE_DEFAULT_MS;
      const reported = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const checkFocusedControl = (): void => {
        timer = undefined;
        if (
          pageLifecycleEnding ||
          document.visibilityState === "hidden" ||
          visualViewport.height >=
            window.innerHeight * KEYBOARD_VIEWPORT_HEIGHT_RATIO_MAX
        ) {
          return;
        }
        const active = focusedEditable();
        if (active === null) return;
        const rect = active.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const viewportTop = visualViewport.offsetTop;
        const viewportBottom = viewportTop + visualViewport.height;
        const obscuredPx = Math.max(
          viewportTop - rect.top,
          rect.bottom - viewportBottom,
          0,
        );
        if (obscuredPx <= 1) return;
        const target = describeElement(active);
        const key = target;
        if (reported.has(key)) return;
        reported.add(key);
        emitSignal(
          `Focused control offscreen — ${target} is outside the mobile visual viewport — ${shortUrl(location.href)}`,
          {
            layoutViewportHeight: String(window.innerHeight),
            obscuredPx: String(Math.round(obscuredPx)),
            signal: BEACON_SIGNAL.FOCUSED_CONTROL_OFFSCREEN,
            target,
            visualViewportHeight: String(Math.round(visualViewport.height)),
            visualViewportOffsetTop: String(
              Math.round(visualViewport.offsetTop),
            ),
          },
        );
      };
      const scheduleCheck = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(checkFocusedControl, settleMs);
      };
      document.addEventListener("focusin", scheduleCheck, true);
      visualViewport.addEventListener("resize", scheduleCheck);
      visualViewport.addEventListener("scroll", scheduleCheck);
      cleanups.push(() => {
        document.removeEventListener("focusin", scheduleCheck, true);
        visualViewport.removeEventListener("resize", scheduleCheck);
        visualViewport.removeEventListener("scroll", scheduleCheck);
        if (timer !== undefined) clearTimeout(timer);
      });
    }

    // Scroll jail: repeated wheel input over scrollable-but-immobile content
    // — the scroll lock a closed modal forgot to release. Boundary no-ops
    // (already at the top/bottom) and app-handled wheels (preventDefault:
    // carousels, canvas zoom) reset the burst instead of counting.
    if (signals.scrollJail !== false) {
      const MODAL_SCROLL_OWNER_SELECTOR = '[aria-modal="true"], dialog[open]';
      const isScrollable = (node: Element): boolean => {
        const overflowY = window.getComputedStyle(node).overflowY;

        return (
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight + 1
        );
      };
      const nearestScrollable = (start: Element | null): Element | null => {
        let node = start;
        while (node !== null && node !== document.body) {
          if (isScrollable(node)) return node;
          node = node.parentElement;
        }

        return null;
      };
      const modalOwnedScroller = (modal: Element): Element | null => {
        const candidates = Array.from(modal.querySelectorAll("*")).filter(
          isScrollable,
        );
        const outermost = candidates.filter(
          (candidate) =>
            !candidates.some(
              (other) => other !== candidate && other.contains(candidate),
            ),
        );

        return outermost.length === 1 ? (outermost[0] ?? null) : null;
      };
      let jailBurst: Array<{ at: number; position: number }> = [];
      let jailScroller: Element | null = null;
      let jailSettleTimer: ReturnType<typeof setTimeout> | undefined;
      let scrollActivityGeneration = 0;
      let jailStartingScrollGeneration = 0;
      const reportedScrollers = new Set<string>();
      const clearJailSettle = (): void => {
        if (jailSettleTimer === undefined) return;
        clearTimeout(jailSettleTimer);
        jailSettleTimer = undefined;
      };
      const onDocumentScroll = (): void => {
        scrollActivityGeneration += 1;
      };
      const onWheel = (event: WheelEvent): void => {
        // A jail is only confirmed after wheel input has gone quiet. Further
        // input may still be feeding a composited scroll that main-thread
        // scrollTop has not exposed yet.
        clearJailSettle();
        if (event.ctrlKey || event.defaultPrevented || event.deltaY === 0) {
          jailBurst = [];

          return;
        }
        const target = event.target instanceof Element ? event.target : null;
        const modal = target?.closest(MODAL_SCROLL_OWNER_SELECTOR) ?? null;
        const scroller =
          nearestScrollable(target) ??
          (modal === null ? null : modalOwnedScroller(modal)) ??
          document.scrollingElement;
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
        if (jailBurst.length === 0) {
          jailStartingScrollGeneration = scrollActivityGeneration;
        }
        jailBurst.push({ at: now, position: scroller.scrollTop });
        if (jailBurst.length < SCROLL_JAIL_EVENT_COUNT) return;
        const first = jailBurst[0];
        const moved =
          first === undefined ||
          jailBurst.some((entry) => entry.position !== first.position) ||
          scroller.scrollTop !== first.position;
        if (moved) {
          jailBurst = [];

          return;
        }
        const startingPosition = first.position;
        jailSettleTimer = setTimeout(() => {
          jailSettleTimer = undefined;
          jailBurst = [];
          if (scrollActivityGeneration !== jailStartingScrollGeneration) return;
          if (!scroller.isConnected || scroller.scrollTop !== startingPosition)
            return;
          const canStillMove = scrollingDown
            ? scroller.scrollTop + scroller.clientHeight <
              scroller.scrollHeight - SCROLL_JAIL_BOUNDARY_TOLERANCE_PX
            : scroller.scrollTop > SCROLL_JAIL_BOUNDARY_TOLERANCE_PX;
          if (!canStillMove) return;
          // An open overlay may lock the page on purpose, but scrolling owned
          // by that overlay must remain usable. A dialog header and its body
          // scroller are commonly siblings, so the wheel target alone is not
          // enough to identify the intended scroll surface.
          if (
            viewportCoveredByOverlay() &&
            (modal === null || !modal.contains(scroller))
          )
            return;
          const descriptor = describeElement(scroller);
          if (reportedScrollers.has(descriptor)) return;
          reportedScrollers.add(descriptor);
          emitSignal(
            `Scroll jail — ${descriptor} has scrollable content but never moves — ${shortUrl(location.href)}`,
            { signal: BEACON_SIGNAL.SCROLL_JAIL, target: descriptor },
          );
        }, SCROLL_JAIL_SETTLE_MS);
      };
      document.addEventListener("scroll", onDocumentScroll, {
        capture: true,
        passive: true,
      });
      document.addEventListener("wheel", onWheel, { passive: true });
      cleanups.push(() => {
        document.removeEventListener("scroll", onDocumentScroll, {
          capture: true,
        });
        document.removeEventListener("wheel", onWheel);
        clearJailSettle();
      });
    }

    if (signals.thrashedCursors !== false) {
      const reversalThreshold =
        signals.thrashedCursorReversals ?? THRASHED_CURSOR_DEFAULT_REVERSALS;
      let points: Array<{ at: number; dx: number; dy: number }> = [];
      let previous: { x: number; y: number } | undefined;
      let reported = false;
      const onPointerMove = (event: PointerEvent): void => {
        if (reported || event.pointerType === "touch") return;
        if (previous === undefined) {
          previous = { x: event.clientX, y: event.clientY };

          return;
        }
        const dx = event.clientX - previous.x;
        const dy = event.clientY - previous.y;
        previous = { x: event.clientX, y: event.clientY };
        if (Math.hypot(dx, dy) < 8) return;
        const now = Date.now();
        points = points.filter(
          (point) => now - point.at < THRASHED_CURSOR_WINDOW_MS,
        );
        points.push({ at: now, dx, dy });
        let reversals = 0;
        for (let index = 1; index < points.length; index += 1) {
          const prior = points[index - 1]!;
          const current = points[index]!;
          const dot = prior.dx * current.dx + prior.dy * current.dy;
          const magnitudeProduct =
            Math.hypot(prior.dx, prior.dy) * Math.hypot(current.dx, current.dy);
          if (dot / magnitudeProduct <= THRASHED_CURSOR_REVERSAL_COSINE)
            reversals += 1;
        }
        if (reversals < reversalThreshold) return;
        reported = true;
        const target =
          event.target instanceof Element
            ? describeElement(event.target)
            : "document";
        emitSignal(
          `Thrashed cursor — repeated direction changes — ${shortUrl(location.href)}`,
          {
            reversals: String(reversals),
            signal: BEACON_SIGNAL.THRASHED_CURSOR,
            target,
          },
        );
      };
      document.addEventListener("pointermove", onPointerMove, {
        passive: true,
      });
      cleanups.push(() =>
        document.removeEventListener("pointermove", onPointerMove),
      );
    }

    // Dialog focus: report both focus dropped after unmount and focus escaping
    // (or never entering) an explicitly modal surface.
    if (signals.focusLoss !== false || signals.modalFocusEscape !== false) {
      const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog';
      const MODAL_SELECTOR = '[aria-modal="true"], dialog[open]';
      let lastDialogFocus: Element | null = null;
      const reportedFocusLoss = new Set<string>();
      const reportedModalEscapes = new WeakSet<Element>();
      const modalTimers = new Set<ReturnType<typeof setTimeout>>();
      const modalVisibility = new WeakMap<Element, boolean>();
      const knownModals = new Set<Element>();
      const isRenderedModal = (modal: Element): boolean => {
        if (!modal.isConnected || !modal.matches(MODAL_SELECTOR)) return false;
        let current: Element | null = modal;
        while (current !== null) {
          if (
            current.hasAttribute("hidden") ||
            current.hasAttribute("inert") ||
            current.getAttribute("aria-hidden")?.toLowerCase() === "true"
          ) {
            return false;
          }
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            style.contentVisibility === "hidden"
          ) {
            return false;
          }
          current = current.parentElement;
        }
        return true;
      };
      const reportModalEscape = (
        modal: Element,
        active: Element | null,
        reason: "escaped" | "initial-focus-missing",
      ): void => {
        if (
          signals.modalFocusEscape === false ||
          reportedModalEscapes.has(modal) ||
          document.visibilityState === "hidden"
        ) {
          return;
        }
        reportedModalEscapes.add(modal);
        const modalDescriptor = describeElement(modal);
        emitSignal(
          `Modal focus escape — ${modalDescriptor} did not contain keyboard focus — ${shortUrl(location.href)}`,
          {
            modal: modalDescriptor,
            reason,
            signal: BEACON_SIGNAL.MODAL_FOCUS_ESCAPE,
            target: active === null ? "none" : describeElement(active),
          },
        );
      };
      const openModals = (): Element[] =>
        Array.from(document.querySelectorAll(MODAL_SELECTOR)).filter(
          isRenderedModal,
        );
      const checkInitialModalFocus = (modal: Element): void => {
        const timer = setTimeout(() => {
          modalTimers.delete(timer);
          if (!isRenderedModal(modal)) return;
          const active =
            document.activeElement instanceof Element
              ? document.activeElement
              : null;
          if (active !== null && modal.contains(active)) return;
          reportModalEscape(modal, active, "initial-focus-missing");
        }, MODAL_FOCUS_SETTLE_MS);
        modalTimers.add(timer);
      };
      const updateModalVisibility = (modal: Element): void => {
        knownModals.add(modal);
        const visible = isRenderedModal(modal);
        const wasVisible = modalVisibility.get(modal) === true;
        modalVisibility.set(modal, visible);
        if (visible && !wasVisible) checkInitialModalFocus(modal);
      };
      const registerModals = (root: Element): void => {
        if (root.matches(MODAL_SELECTOR)) updateModalVisibility(root);
        for (const modal of Array.from(root.querySelectorAll(MODAL_SELECTOR))) {
          updateModalVisibility(modal);
        }
      };
      const onFocusIn = (event: FocusEvent): void => {
        const target = event.target;
        if (signals.modalFocusEscape !== false && target instanceof Element) {
          const modals = openModals();
          if (
            modals.length > 0 &&
            !modals.some((modal) => modal.contains(target))
          ) {
            const modal = modals[modals.length - 1]!;
            // Frameworks commonly restore focus before their render pass
            // removes a closing modal. Confirm the escape after microtasks and
            // DOM updates settle instead of reporting that transient state.
            const timer = setTimeout(() => {
              modalTimers.delete(timer);
              if (!isRenderedModal(modal)) return;
              const active =
                document.activeElement instanceof Element
                  ? document.activeElement
                  : null;
              if (active !== null && modal.contains(active)) return;
              reportModalEscape(modal, active, "escaped");
            }, 0);
            modalTimers.add(timer);
          }
        }
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
      let modalObserver: MutationObserver | undefined;
      if (
        signals.modalFocusEscape !== false &&
        typeof MutationObserver !== "undefined"
      ) {
        for (const modal of Array.from(
          document.querySelectorAll(MODAL_SELECTOR),
        )) {
          updateModalVisibility(modal);
        }
        modalObserver = new MutationObserver((records) => {
          for (const record of records) {
            if (
              record.type === "attributes" &&
              record.target instanceof Element
            ) {
              const target = record.target;
              if (knownModals.has(target) || target.matches(MODAL_SELECTOR)) {
                updateModalVisibility(target);
              }
              for (const modal of knownModals) {
                if (modal !== target && target.contains(modal)) {
                  updateModalVisibility(modal);
                }
              }
            }
            for (const added of Array.from(record.addedNodes)) {
              if (!(added instanceof Element)) continue;
              registerModals(added);
            }
          }
        });
        modalObserver.observe(document.documentElement, {
          attributeFilter: [
            "aria-hidden",
            "aria-modal",
            "class",
            "hidden",
            "inert",
            "open",
            "style",
          ],
          attributes: true,
          childList: true,
          subtree: true,
        });
      }
      cleanups.push(() => {
        document.removeEventListener("focusin", onFocusIn, true);
        document.removeEventListener("focusout", onFocusOut, true);
        modalObserver?.disconnect();
        for (const timer of modalTimers) clearTimeout(timer);
        modalTimers.clear();
        knownModals.clear();
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

    if (signals.formAbandonment !== false) {
      const dirtyForms = new Set<HTMLFormElement>();
      const submittedForms = new WeakSet<HTMLFormElement>();
      const onInput = (event: Event): void => {
        const target = event.target;
        const form =
          target instanceof HTMLInputElement ||
          target instanceof HTMLSelectElement ||
          target instanceof HTMLTextAreaElement
            ? target.form
            : null;
        if (form?.hasAttribute(BEACON_ATTRIBUTE.FORM) === true) {
          dirtyForms.add(form);
        }
      };
      const onSubmit = (event: Event): void => {
        if (!(event.target instanceof HTMLFormElement)) return;
        submittedForms.add(event.target);
        dirtyForms.delete(event.target);
      };
      const report = (departedUrl = location.href): void => {
        for (const form of dirtyForms) {
          if (!form.isConnected || submittedForms.has(form)) continue;
          const name =
            form.getAttribute(BEACON_ATTRIBUTE.FORM)?.trim() ||
            describeElement(form);
          emitSignal(
            `Form abandonment — ${name} left dirty — ${shortUrl(departedUrl)}`,
            {
              fieldCount: String(form.elements.length),
              signal: BEACON_SIGNAL.FORM_ABANDONMENT,
              target: name,
              url: shortUrl(departedUrl),
            },
          );
          dirtyForms.delete(form);
        }
      };
      reportFormAbandonmentOnNavigation = report;
      document.addEventListener("input", onInput, true);
      document.addEventListener("submit", onSubmit, true);
      const reportOnPageHide = (event: PageTransitionEvent): void => {
        // A persisted pagehide moves this live document into the back-forward
        // cache. Its form and dirty state survive and may be submitted after
        // pageshow, so this is not an abandonment. Keep the dirty set intact
        // for a later submit, SPA navigation, or terminal pagehide.
        if (event.persisted) return;
        report();
      };
      window.addEventListener("pagehide", reportOnPageHide);
      cleanups.push(() => {
        reportFormAbandonmentOnNavigation = null;
        document.removeEventListener("input", onInput, true);
        document.removeEventListener("submit", onSubmit, true);
        window.removeEventListener("pagehide", reportOnPageHide);
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
    (signals.stalledStreams !== false || signals.sseFlapping !== false) &&
    typeof window.EventSource === "function"
  ) {
    const stalledStreamMs =
      signals.stalledStreamMs ?? STALLED_STREAM_DEFAULT_MS;
    const sseFlapCount = signals.sseFlapCount ?? SSE_FLAP_DEFAULT_COUNT;
    const sseFlapWindowMs =
      signals.sseFlapWindowMs ?? SSE_FLAP_DEFAULT_WINDOW_MS;
    const OriginalEventSource = window.EventSource;
    const reportedStreams = new Set<string>();
    const errorsByEndpoint = new Map<string, number[]>();
    const reportedFlappingStreams = new Set<string>();
    // Quiet-by-design endpoints: push topics whose silence is health, not
    // failure. Matched against the stream's full URL — prefix or RegExp.
    const quietStream = (url: string): boolean =>
      (signals.quietStreams ?? []).some((pattern) =>
        typeof pattern === "string"
          ? url.startsWith(pattern) || shortUrl(url).startsWith(pattern)
          : pattern.test(url),
      );
    const instrumentSource = (
      source: EventSource,
      endpointLabel: string,
      sourceUrl: string,
    ): void => {
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const disarm = (): void => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
      };
      const check = (): void => {
        if (signals.stalledStreams === false) return;
        if (quietStream(sourceUrl)) return;
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
      const recordError = (): void => {
        disarm();
        if (
          signals.sseFlapping === false ||
          pageLifecycleEnding ||
          document.visibilityState === "hidden"
        ) {
          return;
        }
        const now = Date.now();
        const errors = (errorsByEndpoint.get(endpointLabel) ?? []).filter(
          (at) => now - at < sseFlapWindowMs,
        );
        errors.push(now);
        errorsByEndpoint.set(endpointLabel, errors);
        if (
          errors.length < sseFlapCount ||
          reportedFlappingStreams.has(endpointLabel)
        ) {
          return;
        }
        reportedFlappingStreams.add(endpointLabel);
        emitSignal(
          `SSE flapping — ${endpointLabel} keeps failing and reconnecting — ${shortUrl(location.href)}`,
          {
            endpoint: endpointLabel,
            errorCount: String(errors.length),
            signal: BEACON_SIGNAL.SSE_FLAPPING,
            windowMs: String(sseFlapWindowMs),
          },
        );
      };
      const arm = (): void => {
        disarm();
        if (signals.stalledStreams === false) return;
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
      originalAddEventListener("error", recordError);
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
        instrumentSource(source, shortUrl(String(args[0])), String(args[0]));

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
    (signals.socketFlapping !== false ||
      signals.socketAbnormalCloses !== false) &&
    typeof window.WebSocket === "function"
  ) {
    const OriginalWebSocket = window.WebSocket;
    const closesByUrl = new Map<string, number[]>();
    const reportedSockets = new Set<string>();
    const reportedAbnormalCloses = new Set<string>();
    const recoverableSocket = (url: string): boolean =>
      (signals.recoverableSockets ?? []).some((pattern) =>
        typeof pattern === "string"
          ? url.startsWith(pattern) || shortUrl(url).startsWith(pattern)
          : pattern.test(url),
      );
    const wrappedWebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args: unknown[]): object {
        const socket = Reflect.construct(target, args) as unknown as WebSocket;
        const socketUrl = String(args[0]);
        const label = shortUrl(socketUrl);
        const socketLifecycleGeneration = pageLifecycleGeneration;
        let applicationClose = false;
        const originalClose = socket.close.bind(socket);
        socket.close = (code?: number, reason?: string): void => {
          applicationClose = true;
          originalClose(code, reason);
        };
        socket.addEventListener("close", (event) => {
          const restoredLifecycleClose =
            pageRestoredAt !== undefined &&
            socketLifecycleGeneration < pageLifecycleGeneration &&
            Date.now() - pageRestoredAt <= RESTORED_SOCKET_CLOSE_GRACE_MS;
          if (pageLifecycleEnding || applicationClose || restoredLifecycleClose)
            return;
          if (
            signals.socketAbnormalCloses !== false &&
            typeof CloseEvent !== "undefined" &&
            event instanceof CloseEvent &&
            !event.wasClean &&
            !recoverableSocket(socketUrl)
          ) {
            const abnormalKey = `${label}|${event.code}`;
            if (!reportedAbnormalCloses.has(abnormalKey)) {
              reportedAbnormalCloses.add(abnormalKey);
              emitSignal(
                `Abnormal socket close — ${label} closed unexpectedly — ${shortUrl(location.href)}`,
                {
                  closeCode: String(event.code),
                  endpoint: label,
                  signal: BEACON_SIGNAL.SOCKET_ABNORMAL_CLOSE,
                  wasClean: String(event.wasClean),
                },
              );
            }
          }
          if (signals.socketFlapping === false) return;
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

  // Worker failures do not reliably reach window.onerror. Instrument worker
  // instances at construction so handled runtime/message failures still carry
  // page, release, breadcrumb, and replay context.
  if (signals !== null && signals.workerFailures !== false) {
    const reportedWorkerFailures = new Set<string>();
    const workerListenerCleanups: Array<() => void> = [];
    cleanups.push(() => {
      for (const cleanup of workerListenerCleanups.splice(
        0,
        workerListenerCleanups.length,
      )) {
        cleanup();
      }
    });
    const reportWorkerFailure = (
      workerType: "dedicated" | "shared",
      endpointLabel: string,
      failureKind: "construction" | "error" | "messageerror",
      error?: Error,
    ): void => {
      const key = `${workerType}|${endpointLabel}|${failureKind}`;
      if (reportedWorkerFailures.has(key)) return;
      reportedWorkerFailures.add(key);
      emitSignal(
        `Worker failure — ${workerType} worker ${endpointLabel} failed — ${shortUrl(location.href)}`,
        {
          endpoint: endpointLabel,
          failureKind,
          signal: BEACON_SIGNAL.WORKER_FAILURE,
          workerType,
        },
        undefined,
        error === undefined
          ? undefined
          : {
              workerError: {
                message: error.message,
                name: error.name,
                ...(error.stack === undefined ? {} : { stack: error.stack }),
              },
            },
      );
    };
    if (typeof window.Worker === "function") {
      const OriginalWorker = window.Worker;
      const wrappedWorker = new Proxy(OriginalWorker, {
        construct(target, args: ConstructorParameters<typeof Worker>): object {
          const endpointLabel = shortUrl(String(args[0]));
          try {
            const worker = Reflect.construct(target, args) as Worker;
            const onError = (event: ErrorEvent): void => {
              const error =
                event instanceof ErrorEvent
                  ? errorWithStack(
                      "WorkerError",
                      event.message || "Worker runtime error",
                      errorEventLocation(event),
                    )
                  : undefined;
              reportWorkerFailure("dedicated", endpointLabel, "error", error);
            };
            const onMessageError = (): void =>
              reportWorkerFailure("dedicated", endpointLabel, "messageerror");
            worker.addEventListener("error", onError);
            worker.addEventListener("messageerror", onMessageError);
            workerListenerCleanups.push(() => {
              worker.removeEventListener("error", onError);
              worker.removeEventListener("messageerror", onMessageError);
            });

            return worker;
          } catch (error) {
            reportWorkerFailure(
              "dedicated",
              endpointLabel,
              "construction",
              toError(error),
            );
            throw error;
          }
        },
      });
      window.Worker = wrappedWorker as typeof Worker;
      cleanups.push(() => {
        if (window.Worker === wrappedWorker) window.Worker = OriginalWorker;
      });
    }
    if (typeof window.SharedWorker === "function") {
      const OriginalSharedWorker = window.SharedWorker;
      const wrappedSharedWorker = new Proxy(OriginalSharedWorker, {
        construct(
          target,
          args: ConstructorParameters<typeof SharedWorker>,
        ): object {
          const endpointLabel = shortUrl(String(args[0]));
          try {
            const worker = Reflect.construct(target, args) as SharedWorker;
            const onError = (event: ErrorEvent): void => {
              const error =
                event instanceof ErrorEvent
                  ? errorWithStack(
                      "WorkerError",
                      event.message || "Shared worker runtime error",
                      errorEventLocation(event),
                    )
                  : undefined;
              reportWorkerFailure("shared", endpointLabel, "error", error);
            };
            const onMessageError = (): void =>
              reportWorkerFailure("shared", endpointLabel, "messageerror");
            worker.addEventListener("error", onError);
            worker.port.addEventListener("messageerror", onMessageError);
            workerListenerCleanups.push(() => {
              worker.removeEventListener("error", onError);
              worker.port.removeEventListener("messageerror", onMessageError);
            });

            return worker;
          } catch (error) {
            reportWorkerFailure(
              "shared",
              endpointLabel,
              "construction",
              toError(error),
            );
            throw error;
          }
        },
      });
      window.SharedWorker = wrappedSharedWorker as typeof SharedWorker;
      cleanups.push(() => {
        if (window.SharedWorker === wrappedSharedWorker) {
          window.SharedWorker = OriginalSharedWorker;
        }
      });
    }
  }

  if (
    signals !== null &&
    signals.serviceWorkerFailures !== false &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator
  ) {
    try {
      const container = navigator.serviceWorker;
      const reportedServiceWorkerFailures = new Set<string>();
      const serviceWorkerListenerCleanups: Array<() => void> = [];
      const pendingRegistrationFailures = new Map<
        string,
        { error: Error; timeout: ReturnType<typeof setTimeout> }
      >();
      const transientRegistrationErrors = new Set([
        "AbortError",
        "NetworkError",
        "TimeoutError",
        "TypeError",
      ]);
      const reportServiceWorkerFailure = (
        endpointLabel: string,
        failureKind: "installation" | "messageerror" | "registration",
        error?: Error,
      ): void => {
        const key = `${endpointLabel}|${failureKind}`;
        if (reportedServiceWorkerFailures.has(key)) return;
        reportedServiceWorkerFailures.add(key);
        emitSignal(
          `Service worker failure — ${endpointLabel} failed during ${failureKind} — ${shortUrl(location.href)}`,
          {
            endpoint: endpointLabel,
            failureKind,
            signal: BEACON_SIGNAL.SERVICE_WORKER_FAILURE,
          },
          undefined,
          error === undefined
            ? undefined
            : {
                serviceWorkerError: {
                  message: error.message,
                  name: error.name,
                  ...(error.stack === undefined ? {} : { stack: error.stack }),
                },
              },
        );
      };
      const watchInstallingWorker = (worker: ServiceWorker): void => {
        let activated = worker.state === "activated";
        const onStateChange = (): void => {
          if (worker.state === "activated") activated = true;
          if (worker.state !== "redundant" || activated) return;
          reportServiceWorkerFailure(
            shortUrl(worker.scriptURL),
            "installation",
          );
        };
        worker.addEventListener("statechange", onStateChange);
        serviceWorkerListenerCleanups.push(() =>
          worker.removeEventListener("statechange", onStateChange),
        );
      };
      const watchRegistration = (
        registration: ServiceWorkerRegistration,
      ): void => {
        if (registration.installing !== null) {
          watchInstallingWorker(registration.installing);
        }
        const onUpdateFound = (): void => {
          if (registration.installing !== null) {
            watchInstallingWorker(registration.installing);
          }
        };
        registration.addEventListener("updatefound", onUpdateFound);
        serviceWorkerListenerCleanups.push(() =>
          registration.removeEventListener("updatefound", onUpdateFound),
        );
      };
      const isServiceWorkerRegistration = (
        registration: unknown,
      ): registration is ServiceWorkerRegistration =>
        typeof registration === "object" &&
        registration !== null &&
        "installing" in registration &&
        typeof (registration as { addEventListener?: unknown })
          .addEventListener === "function";
      const originalRegister = container.register;
      const wrappedRegister: typeof container.register = async function (
        this: ServiceWorkerContainer,
        scriptURL,
        registrationOptions,
      ) {
        const endpointLabel = shortUrl(String(scriptURL));
        try {
          const registration = await originalRegister.call(
            this,
            scriptURL,
            registrationOptions,
          );
          // Restricted browser shims may resolve without the platform's
          // registration object. Do not turn Beacon's observer into the
          // service-worker failure in that non-standard environment.
          if (isServiceWorkerRegistration(registration)) {
            watchRegistration(registration);
          }
          const pendingFailure = pendingRegistrationFailures.get(endpointLabel);
          if (pendingFailure !== undefined) {
            clearTimeout(pendingFailure.timeout);
            pendingRegistrationFailures.delete(endpointLabel);
          }

          return registration;
        } catch (error) {
          const registrationError = toError(error);
          if (transientRegistrationErrors.has(registrationError.name)) {
            const existing = pendingRegistrationFailures.get(endpointLabel);
            if (existing !== undefined) {
              existing.error = registrationError;
            } else {
              const recoveryMs = Math.max(
                0,
                signals.serviceWorkerRecoveryMs ??
                  SERVICE_WORKER_RECOVERY_DEFAULT_MS,
              );
              const pending = {
                error: registrationError,
                timeout: setTimeout(() => {
                  pendingRegistrationFailures.delete(endpointLabel);
                  reportServiceWorkerFailure(
                    endpointLabel,
                    "registration",
                    pending.error,
                  );
                }, recoveryMs),
              };
              pendingRegistrationFailures.set(endpointLabel, pending);
            }
          } else {
            reportServiceWorkerFailure(
              endpointLabel,
              "registration",
              registrationError,
            );
          }
          throw error;
        }
      };
      container.register = wrappedRegister;
      const onMessageError = (): void =>
        reportServiceWorkerFailure("service-worker", "messageerror");
      container.addEventListener("messageerror", onMessageError);
      cleanups.push(() => {
        container.removeEventListener("messageerror", onMessageError);
        for (const pending of pendingRegistrationFailures.values()) {
          clearTimeout(pending.timeout);
        }
        pendingRegistrationFailures.clear();
        for (const cleanup of serviceWorkerListenerCleanups.splice(
          0,
          serviceWorkerListenerCleanups.length,
        )) {
          cleanup();
        }
        if (container.register === wrappedRegister) {
          container.register = originalRegister;
        }
      });
    } catch {
      // Service workers may be unavailable in insecure or restricted contexts.
    }
  }

  // ——— Boot-time watchdogs ——————————————————————————————————————————————
  // Reload loop: several uninterrupted same-route document loads inside a
  // minute — a crash loop, redirect bounce, or a user mashing refresh against
  // a broken page. A different app route breaks the streak. So does a fresh
  // external entry (including an OAuth/SAML return) or an accepted service
  // worker update: neither is evidence that this route reloaded itself.
  if (
    signals !== null &&
    signals.reloadLoops !== false &&
    typeof sessionStorage !== "undefined"
  ) {
    try {
      const navigation = performance.getEntriesByType("navigation")[0] as
        PerformanceNavigationTiming | undefined;
      if (navigation?.type !== "back_forward") {
        const now = Date.now();
        // Storage stays in this browser tab and is never transported. Keep the
        // exact pathname here so rapidly opening several entity-detail pages
        // does not look like repeated loads after privacy fingerprinting turns
        // every UUID into `:id`. The emitted message/grouping below remains
        // normalized and privacy-safe.
        const route = shortUrl(location.href);
        const raw = sessionStorage.getItem(RELOAD_LOOP_STORAGE_KEY);
        const parsed: unknown = raw === null ? [] : JSON.parse(raw);
        let history = (Array.isArray(parsed) ? parsed : []).filter(
          (entry): entry is { at: number; route: string } =>
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as { at?: unknown }).at === "number" &&
            typeof (entry as { route?: unknown }).route === "string" &&
            now - (entry as { at: number }).at < RELOAD_LOOP_WINDOW_MS,
        );

        let entryKind = "app";
        const rawNavigationIntent = sessionStorage.getItem(
          NAVIGATION_INTENT_STORAGE_KEY,
        );
        sessionStorage.removeItem(NAVIGATION_INTENT_STORAGE_KEY);
        const navigationIntentAt = Number(rawNavigationIntent);
        if (
          rawNavigationIntent !== null &&
          Number.isFinite(navigationIntentAt) &&
          now - navigationIntentAt >= 0 &&
          now - navigationIntentAt <= NAVIGATION_INTENT_MAX_AGE_MS
        ) {
          // A form submission or same-tab link may legitimately return to the
          // exact same URL (invalid credentials, account switching, payment
          // authorization). That is a new user-directed navigation, not a page
          // repeatedly reloading itself.
          history = [];
          entryKind = "intentional-navigation";
        }
        if (document.referrer !== "") {
          const referrer = new URL(document.referrer, location.href);
          if (referrer.origin !== location.origin) {
            // Authentication providers, payment providers, search results, and
            // ordinary external links are new journeys into the app. Do not
            // join them to page loads from before the user left our origin.
            history = [];
            entryKind = "external";
          } else {
            const controllerScript =
              navigator.serviceWorker?.controller?.scriptURL;
            if (
              controllerScript !== undefined &&
              new URL(controllerScript, location.href).pathname ===
                referrer.pathname
            ) {
              // controllerchange reloads are explicit app-update handoffs. Some
              // browsers expose the worker script as the document referrer.
              history = [];
              entryKind = "service-worker-update";
            }
          }
        }

        history.push({ at: now, route });
        sessionStorage.setItem(
          RELOAD_LOOP_STORAGE_KEY,
          JSON.stringify(history),
        );
        let loadCount = 0;
        for (let index = history.length - 1; index >= 0; index -= 1) {
          if (history[index]?.route !== route) break;
          loadCount += 1;
        }
        // Emit once when a streak crosses the threshold. Continuing loops do
        // not create one duplicate issue event per subsequent document load.
        if (loadCount === RELOAD_LOOP_COUNT) {
          const firstLoad = history.at(-loadCount)?.at ?? now;
          emitSignal(
            `Reload loop — repeated page loads within a minute — ${shortUrl(location.href)}`,
            {
              entryKind,
              loadCount: String(loadCount),
              navigationType: navigation?.type ?? "unknown",
              signal: BEACON_SIGNAL.RELOAD_LOOP,
              windowMs: String(now - firstLoad),
            },
          );
        }
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
    "fonts" in document &&
    (typeof navigator === "undefined" || navigator.webdriver !== true)
  ) {
    const reportedFonts = new Set<string>();
    const checkingFonts = new Set<string>();
    const confirmationMs = Math.max(
      0,
      signals.fontFailureConfirmMs ?? FONT_FAILURE_CONFIRM_DEFAULT_MS,
    );
    const normalizedFamily = (family: string): string =>
      family
        .trim()
        .replace(/^(['"])(.*)\1$/u, "$2")
        .toLowerCase();
    const isRendered = (element: HTMLElement): boolean => {
      for (
        let current: HTMLElement | null = element;
        current !== null;
        current = current.parentElement
      ) {
        const style = window.getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity || "1") <= 0.01
        ) {
          return false;
        }
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const affectedElement = (family: string): HTMLElement | null => {
      const expected = normalizedFamily(family);
      for (const element of document.querySelectorAll<HTMLElement>("body *")) {
        if (!isRendered(element)) continue;
        const style = window.getComputedStyle(element);
        const families = style.fontFamily.split(",").map(normalizedFamily);
        if (families.includes(expected)) return element;
      }
      return null;
    };
    const reportFontFailure = (
      face: FontFace,
      element: HTMLElement,
      key: string,
    ): void => {
      reportedFonts.add(key);
      emitSignal(
        `Font failure — ${face.family} failed to load — ${shortUrl(location.href)}`,
        {
          fontFamily: face.family,
          fontStretch: face.stretch,
          fontStyle: face.style,
          fontWeight: face.weight,
          signal: BEACON_SIGNAL.FONT_FAILURE,
          target: describeElement(element),
        },
      );
    };
    const verifyFontFailure = async (face: FontFace): Promise<void> => {
      const key = [face.family, face.style, face.weight, face.stretch].join(
        "|",
      );
      if (reportedFonts.has(key) || checkingFonts.has(key)) return;
      const element = affectedElement(face.family);
      if (element === null) return;
      checkingFonts.add(key);
      const fontAvailable = async (consumer: HTMLElement): Promise<boolean> => {
        const sample = consumer.textContent?.trim().slice(0, 64) || "BESbswy";
        const font = `${face.style} ${face.weight} ${face.stretch} 16px ${JSON.stringify(face.family)}`;
        try {
          await document.fonts.load(font, sample);
          return document.fonts.check(font, sample);
        } catch {
          return false;
        }
      };
      try {
        if (await fontAvailable(element)) return;
        if (confirmationMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, confirmationMs);
            cleanups.push(() => window.clearTimeout(timer));
          });
          if (document.visibilityState === "hidden") return;
          const confirmedElement = affectedElement(face.family);
          if (confirmedElement === null) return;
          if (await fontAvailable(confirmedElement)) return;
          reportFontFailure(face, confirmedElement, key);
          return;
        }
        reportFontFailure(face, element, key);
      } finally {
        checkingFonts.delete(key);
      }
    };
    const sweepFonts = (): void => {
      document.fonts.forEach((face) => {
        if (face.status === "error") void verifyFontFailure(face);
      });
    };
    const fontsReady: Promise<unknown> | undefined = document.fonts.ready;
    if (fontsReady !== undefined) {
      void fontsReady.then(sweepFonts).catch(() => undefined);
    }
    if (typeof document.fonts.addEventListener === "function") {
      const handleLoadingError = (): void => sweepFonts();
      document.fonts.addEventListener("loadingerror", handleLoadingError);
      cleanups.push(() =>
        document.fonts.removeEventListener("loadingerror", handleLoadingError),
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

  const classifySemanticResponse = (
    response: Response,
    request: { method: string; url: string },
  ): void => {
    const classifier = instrument.classifyResponse;
    if (classifier === undefined || !response.ok) return;
    void Promise.resolve(classifier(response.clone(), request))
      .then((result) => {
        if (result === undefined || result === false) return;
        captureException(
          errorWithoutStack("SemanticResponseFailure", result.message),
          {
            groupingKey: result.groupingKey,
            level: "warning",
            tags: {
              endpoint: shortUrl(request.url),
              method: request.method.toUpperCase(),
              signal: BEACON_SIGNAL.SEMANTIC_RESPONSE_FAILURE,
              ...(result.tags ?? {}),
            },
          },
        );
      })
      .catch(() => {
        // The host classifier is diagnostic-only and cannot affect requests.
      });
  };

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
        classifySemanticResponse(response, { method, url });
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
              if (
                instrument.classifyResponse !== undefined &&
                this.status >= 200 &&
                this.status < 300 &&
                (this.responseType === "" || this.responseType === "text")
              ) {
                const headers = new Headers();
                for (const line of this.getAllResponseHeaders().split(
                  /\r?\n/u,
                )) {
                  const separator = line.indexOf(":");
                  if (separator <= 0) continue;
                  headers.append(
                    line.slice(0, separator).trim(),
                    line.slice(separator + 1).trim(),
                  );
                }
                classifySemanticResponse(
                  new Response(this.responseText, {
                    headers,
                    status: this.status,
                    statusText: this.statusText,
                  }),
                  request,
                );
              }
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
    let recordedHistoryUrl = location.href;
    const record = (): void => {
      addBreadcrumb({
        message: `navigate ${location.pathname}${location.search}`,
        type: "navigation",
      });
      recordedHistoryUrl = location.href;
      // The new route's layout deserves the same overflow check as a resize.
      overflowScanOnNavigation?.();
    };
    const patch = (key: "pushState" | "replaceState"): (() => void) => {
      const original = history[key].bind(history);
      history[key] = (...args: Parameters<History["pushState"]>) => {
        const departedUrl = location.href;
        const destination = args[2];
        let changesUrl = false;
        if (destination !== undefined && destination !== null) {
          try {
            changesUrl =
              new URL(String(destination), departedUrl).href !== departedUrl;
          } catch {
            // Non-browser DOM hosts can expose a non-hierarchical base such as
            // about:blank while still implementing path-based history. The
            // native method below remains authoritative for invalid URLs.
            const rawDestination = String(destination);
            changesUrl =
              rawDestination !== departedUrl &&
              rawDestination !==
                `${location.pathname}${location.search}${location.hash}`;
          }
        }
        const result = original(...args);
        if (!changesUrl) return result;
        reportFormAbandonmentOnNavigation?.(departedUrl);
        record();
        return result;
      };
      return () => {
        history[key] = original;
      };
    };
    cleanups.push(patch("pushState"), patch("replaceState"));
    const onPopState = (): void => {
      if (location.href === recordedHistoryUrl) return;
      reportFormAbandonmentOnNavigation?.(recordedHistoryUrl);
      record();
    };
    window.addEventListener("popstate", onPopState);
    cleanups.push(() => window.removeEventListener("popstate", onPopState));
  }

  // Flush on a timer + when the page is hidden / unloaded (the reliable moment).
  const timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  (timer as { unref?: () => void }).unref?.();
  cleanups.push(() => clearInterval(timer));

  const onPageHide = (): void => {
    pageLifecycleEnding = true;
    pageLifecycleGeneration += 1;
    pageRestoredAt = undefined;
    // Browsers do not consistently surface navigation-cancelled fetches as
    // AbortError. Chromium can reject them with TypeError("Failed to fetch"),
    // so discard only pending generic transport failures during page teardown.
    // Offline and timeout failures remain actionable and are still flushed.
    pendingNetworkFailures.delete("transport");
    if (
      pendingNavigationIntentAt !== undefined &&
      Date.now() - pendingNavigationIntentAt <= NAVIGATION_INTENT_MAX_AGE_MS
    ) {
      try {
        sessionStorage.setItem(
          NAVIGATION_INTENT_STORAGE_KEY,
          String(Date.now()),
        );
      } catch {
        // Storage unavailable — reload-loop detection already degrades safely.
      }
    }
    void flush(true);
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    pageLifecycleEnding = false;
    pageRestoredAt = event.persisted ? Date.now() : undefined;
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") void flush(true);
  };
  const onNavigationIntent = (event: Event): void => {
    if (event.type === "submit") {
      pendingNavigationIntentAt = Date.now();
      return;
    }
    if (!(event instanceof MouseEvent) || event.button !== 0) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest("a[href]");
    if (
      anchor instanceof HTMLAnchorElement &&
      anchor.target !== "_blank" &&
      !anchor.hasAttribute("download")
    ) {
      pendingNavigationIntentAt = Date.now();
    }
  };
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("click", onNavigationIntent, true);
  document.addEventListener("submit", onNavigationIntent, true);
  document.addEventListener("visibilitychange", onVisibilityChange);
  cleanups.push(
    () => window.removeEventListener("pagehide", onPageHide),
    () => window.removeEventListener("pageshow", onPageShow),
    () => document.removeEventListener("click", onNavigationIntent, true),
    () => document.removeEventListener("submit", onNavigationIntent, true),
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
    observeCapability,
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

/** Observe an application-owned browser capability against the global beacon. */
export const observeCapability = <T>(
  name: string,
  operation: Promise<T>,
): Promise<T> => current?.observeCapability(name, operation) ?? operation;
