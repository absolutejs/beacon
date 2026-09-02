# @absolutejs/beacon

> Tiny, zero-dependency browser SDK for the AbsoluteJS observability stack.
> **~2 KB gzipped.**

Captures uncaught errors + unhandled rejections, records breadcrumbs
(console / click / fetch / navigation), batches, and POSTs an envelope to
[`@absolutejs/errors/ingest`](https://www.npmjs.com/package/@absolutejs/errors)
via `navigator.sendBeacon` / `fetch` keepalive.

## Why it's not Effect-native (on purpose)

A browser SDK loads on **every page for every user**, so bytes are the dominant
cost. Measured: an Effect-native client is **~108 KB gz**; this is **~2 KB gz**.
The client has no trust boundary — it's a dumb producer of telemetry — so the
Effect/Schema rigor lives **server-side** in `@absolutejs/errors/ingest`, which
validates the untrusted POST body.

You lose nothing on type safety: the envelope is **contract-locked** to the
ingest endpoint's accepted shape by a compile-time assertion (the type spans the
wire; the runtime machinery does not). Change the shape on either side and the
build breaks.

## Install

```sh
bun add @absolutejs/beacon
```

Zero runtime dependencies.

## Quick start

```ts
import { initBeacon, captureException } from "@absolutejs/beacon";

initBeacon({
  project: "web",
  endpoint: "https://api.example.com/ingest",
  release: import.meta.env.VITE_RELEASE,
  environment: "production",
  // Optional: detect a tab that stayed open across a deployment. The endpoint
  // may return either `{ commit: "..." }` or `{ release: "..." }`.
  releaseProbe: {
    endpoint: "/version",
    onStale: () => window.location.reload(),
  },
});

// Uncaught errors + unhandled rejections are captured automatically.
// Manual capture anywhere:
try {
  await checkout();
} catch (e) {
  captureException(e, { tags: { component: "billing" } });
}
```

Or hold an instance instead of the global:

```ts
import { createBeacon } from "@absolutejs/beacon";
const beacon = createBeacon({ project: "web" });
beacon.setUser({ id: currentUserId });
beacon.captureMessage("checkout started", "info");
```

### Preserve pre-hydration layout shifts

If Beacon itself is loaded lazily, install its zero-configuration early buffer
from the synchronous application entry before framework hydration:

```ts
import { installEarlyLayoutShiftBuffer } from "@absolutejs/beacon/early";

installEarlyLayoutShiftBuffer();
```

The full Beacon instance consumes this buffer automatically when disruptive
layout-shift signals are enabled. It retains the entry's original performance
time, observation time, source rectangles, viewport and document state, plus
resize and privacy-safe interaction timing. This avoids misclassifying a
buffered startup entry using only state observed after hydration. The early
entry point does not initialize Beacon, send telemetry, or import the main SDK.

## What it does

- **Auto-capture** — `window.onerror` + `unhandledrejection` (toggle via `instrument`).
- **Breadcrumbs** — `console.error`/`warn`, clicks, `fetch` (skipping its own
  ingest endpoint), and SPA navigations, in a ring buffer attached to each event.
- **Batching** — buffers up to `maxBatch` (default 30) / `flushIntervalMs`
  (default 5s); flushes reliably on `pagehide` / tab-hidden via `sendBeacon`.
- **Context** — `setTags`, `setUser`, per-call `tags`/`extra`, a per-session id.
- **Stable semantic grouping** — pass `groupingKey` for synthetic or provider
  failures whose stack or wording can move between releases. The matching
  `@absolutejs/errors` ingest service validates and hashes it server-side;
  clients never choose raw fingerprints. Beacon's built-in signals always add
  a stable grouping key derived from the normalized route and semantic target,
  excluding durations, counts, release ids, entity UUIDs, and collector stacks.
- **Cause chains** — preserves nested `Error.cause` stacks and diagnostic fields
  in `extra.errorCauses`, including database driver error codes and details.
- **Sampling + redaction** — `sampleRate`, a `beforeSend(event)` hook
  (return `null` to drop), and default credential/context redaction after the
  hook so host customization cannot accidentally reintroduce secrets. URL
  query/hash values, secret-bearing fields, bearer/JWT values, and breadcrumb
  text are sanitized. Set `redact: false` only when a trusted boundary replaces
  it.
- **Noise filtering** — known browser-host/scanner failures such as CefSharp's
  `Object Not Found Matching Id` rejection and confirmed Meta in-app-browser
  native-bridge injection failures are dropped by default. Known crawler and
  security-scanner user agents are dropped before they can create synthetic UI,
  service-worker, or transport issues
  (`filterKnownNoise: false` opts out).
- **Resource policy** — `instrument.resourceErrors` accepts a predicate so
  expected failures such as optional cross-origin images can become grouped
  warnings while same-origin assets and critical scripts/styles remain errors.
- **Replay seam** — `getReplayId()` stamps each event with the active
  session-replay id (wired by `@absolutejs/replay`).
- **5xx correlation** — fetch and XHR server-error signals preserve the request
  method and copy a valid trace id from the `x-absolute-trace-id` response
  header into the event's top-level `traceId`.
- **Actionable click signals** — dead/rage-click issues are grouped by route and
  stable control descriptor instead of one shared SDK stack. Add
  `data-beacon-name="save-profile"` when CSS alone is ambiguous. Add
  `data-beacon-dead-click="ignore"` to controls whose response is outside the
  page, such as native file, permission, payment, or screen-sharing dialogs.
  Framework-driven form updates are recognized from live value, checked, and
  selection state even when no DOM attribute mutation occurs. Programmatic
  `window.open` calls and same-tick fetch/XHR requests are also recognized
  automatically. When an SPA router accepts a same-origin anchor, Beacon keeps
  observing for up to `signals.navigationResponseMs` (default 8s), allowing a
  lazy route chunk to load without hiding a navigation that genuinely stalls.
  Controls marked active through `aria-current`, `aria-pressed`, or
  `aria-selected` are excluded because clicking the already-current state is an
  intentional no-op; semantic anchors remain preferred for navigation.
- **Layout-overflow signals** — once layout settles (first load, resize end,
  SPA navigation), a capped, deduped scan reports elements that visibly break
  their bounds: in-flow elements crossing the viewport's horizontal edges, a
  child painting past a non-scrolling parent (the flex-squeeze cutoff), and
  content cut by `overflow: hidden` without an ellipsis treatment. Issues
  group per element, kind, and viewport bucket (`xs/sm/md/lg/xl`), with the
  spill size in tags. Hidden/off-canvas subtrees, icon-font glyph paint bounds,
  scroll containers, and absolutely positioned escapees (badges, popovers,
  drawers) are skipped by design; mark deliberate
  bleeds with `data-beacon-overflow="allow"`.
  Geometry scans pause while the mobile visual viewport is horizontally
  shifted or zoomed, so iOS keyboard/pan coordinates are not mistaken for
  document overflow.
- **Control-collision signals** — the same settled scan reports interactive
  controls from separate layout groups whose border boxes overlap or render
  with effectively no spacing. Same-parent rows, semantic control groups,
  navigation, and positioned controls that merely touch are excluded so tabs,
  segmented controls, and floating actions remain quiet. Tune the near-touch
  threshold with `signals.controlCollisionGapPx`. Mark nested controls that
  intentionally meet with `data-beacon-control-group`; this suppresses only
  near-touch reports, while true overlaps remain visible. Use
  `data-beacon-scan="allow"` only when the whole subtree must be exempt from
  every visual scan.
- **Ambient watchdogs** — silent failures users abandon instead of reporting
  become warning issues: scroll jail (a leaked modal scroll lock), stuck
  loading (`aria-busy`/`role="progressbar"` that never resolves), occluded
  controls (leaked scrims/z-index bugs, skipped while a dialog is open),
  invisible headings, controls, and semantic prose (fg composites to its
  background — theme-token bugs),
  stalled `EventSource` streams, WebSocket connect/close flapping, request
  storms (one endpoint hammered in seconds), reload loops, stale releases (a
  service worker serving a build older than one this browser already ran),
  required font-face load failures (excluding intentional optional fallback),
  focus dropped to `<body>` when a dialog unmounts,
  focus escaping or never entering an explicit modal, browser interventions,
  enforced CSP violations, repeated visible-page main-thread stalls, and form
  frustration (identical resubmits / repeated native-validation failures).
  Each is individually toggleable on `signals`, deduped, capped, and exempts
  `data-beacon-scan="allow"` subtrees where a DOM scan is involved.
  Reload loops require repeated loads of the same normalized route; ordinary
  navigation across several pages does not qualify. Occlusion scans exclude
  hidden, inert, transparent, and pointer-disabled control subtrees.
  Applications can also configure `releaseProbe` to compare a long-lived page's
  embedded release with a same-origin server endpoint. After a mismatch Beacon
  reports one `stale_release`, suppresses synthetic issue signals from the
  obsolete detector bundle, and invokes `onStale` after flushing. Every event
  carries `sdkVersion` and `pageStartedAt` in `extra` for collector-side stale
  evidence policy.
- **Theme and loading contracts** — mark an application boundary with
  `data-beacon-theme="adaptive"` to report large opaque surfaces whose
  luminance polarity contradicts the active light/dark mode. Interactive
  controls use a smaller area threshold so light-only buttons do not disappear
  inside an otherwise dark UI; tune it with
  `signals.themeMismatchControlMinArea`. Intentional
  inverted brand/media surfaces use `data-beacon-theme="allow"`. Loading UI
  participates through native `aria-busy`/`role="progressbar"` semantics or
  `data-beacon-loading`, without coupling the SDK to framework class names.
  Determinate progressbars with `aria-valuenow` are persistent status meters,
  not loaders, unless also marked with `aria-busy="true"` or
  `data-beacon-loading`.
  Long-running loaders can set `data-beacon-loading-timeout="60000"` to
  override the global stuck-loading deadline for that element only.
- **Browser capability failures** — rejected clipboard writes are observed even
  when application code catches them (contents are never read), visible WebGL
  contexts that do not restore after `webglcontextlost` become warnings, and a
  focused editable control stranded behind the mobile visual viewport is
  reported after the keyboard settles.
- **Embedded-content stalls** — visible iframes explicitly named with
  `data-beacon-embed` report when their initial `load` never arrives. Generic
  cross-origin error pages cannot be inspected, so Beacon deliberately makes no
  stronger claim than the load deadline.
- **Actionable network signals** — expected aborts remain breadcrumbs instead of
  issues; offline, timeout, isolated-endpoint, and multi-endpoint connectivity
  failures are classified separately. HTTP 429 responses and repeated 401/403
  responses surface rate-limit and authorization storms without treating one
  ordinary authorization rejection as an issue. Concurrent failures become one
  event with every attempt, method, endpoint, duration, original error/stack,
  online state, transport, and page visibility preserved in
  `extra.networkFailures`.
- **Runtime boundary signals** — abnormal WebSocket closes, WebSocket and SSE
  reconnect flapping, terminal service-worker registration/install failures, and
  dedicated/shared worker construction, runtime, and message-decoding failures
  become replay-linked warnings. Normal socket closes, page teardown, hidden-tab
  SSE errors, transient registrations recovered during the configured grace
  period, and successfully replaced service workers are exempt.
- **Attributed reliability signals** — Event Timing identifies genuinely slow
  interactions and separates input delay, handler time, and presentation delay.
  Overlapping long animation frames include their worst script when the browser
  exposes it; missing browser attribution is labeled explicitly. Layout
  Instability names shifted elements. When the browser supplies no shifted
  node, Beacon retains startup/runtime phase plus recent interaction type,
  target, and age; stable provenance separates issue grouping while volatile
  age remains diagnostic-only. Layout shifts during the first two seconds after
  an accepted `pushState`, `replaceState`, or `popstate` route change are treated
  as route settling; later shifts retain navigation type, source, destination,
  and age for diagnosis. Successful HTTP responses can be
  classified through the host-owned `instrument.classifyResponse` callback for
  GraphQL-style errors. Selected HTTP 4xx/5xx responses can be promoted through
  the opt-in `instrument.classifyErrorResponse` callback when application context
  proves they are internal contract failures. Beacon never retains response
  bodies.
- **Lifecycle and platform gaps** — marked empty application roots, marked dirty
  forms abandoned during navigation, marked media errors/stalls, Web Storage and
  IndexedDB failures, discarded documents, bfcache rejection reasons, slow
  static resources, policy reports, connection changes, and opt-in User Timing
  measures are observable. `observeCapability(name, promise)` captures handled
  browser-API rejection while preserving normal promise behavior. Crash reports
  require the server-side Reporting API receiver in `@absolutejs/errors` because
  the page cannot execute after its browser process crashes.

## API

```ts
createBeacon(options) => Beacon
initBeacon(options)   => Beacon   // also sets the global singleton
getBeacon()           => Beacon | undefined

// Beacon:
captureException(error, { groupingKey?, level?, traceId?, spanId?, tags?, extra? })
captureMessage(message, level?, { groupingKey?, traceId?, spanId?, tags?, extra? })
addBreadcrumb({ message, type?, data? })
setTags(tags) · setUser(user | null)
observeCapability(name, promise) => Promise
flush() => Promise<void>          // buffered events out now
close() => Promise<void>          // remove listeners + final flush

// Typed names for event.tags.signal in beforeSend policies (all built-ins):
BEACON_SIGNAL.FETCH_FAILED
BEACON_SIGNAL.SLOW_RESPONSE
BEACON_SIGNAL.HTTP_5XX
BEACON_SIGNAL.HTTP_RESPONSE_FAILURE
BEACON_TRACE_HEADER // "x-absolute-trace-id"

// Global helpers (no-op until initBeacon): captureException, captureMessage,
// addBreadcrumb, observeCapability
```

SSR-safe: imported in a non-DOM environment, `createBeacon` returns a no-op.

Semantic grouping keys require `@absolutejs/errors` 0.7.3 or newer at the
ingest boundary.

## Noise policy (`@absolutejs/beacon/policy`)

An issue board is only worth opening if everything on it is real. Every
application that ships Beacon ends up writing the same `beforeSend` filter — and
most of what goes in it is not application-specific at all: a stale chunk import
after a deploy, a theme extension rewriting inline styles before hydration, a
read that failed while the tab was hidden, a 5xx the server already captured
with a stack. What differs is a handful of endpoints and hostnames.

```ts
import {
  createNoisePolicy,
  createResourceFailurePolicy,
  reliabilitySignalPreset,
  BEACON_SIGNAL,
} from "@absolutejs/beacon/policy";

const isNoise = createNoisePolicy({
  // Signals these endpoints raise in normal operation: a stream that stays
  // open for a whole shift, an upload that is megabytes by design.
  exemptions: [
    {
      signals: [BEACON_SIGNAL.SLOW_RESPONSE, BEACON_SIGNAL.FETCH_FAILED],
      endpoints: ["/sync", "/stream"],
    },
    {
      signals: [BEACON_SIGNAL.SLOW_RESPONSE],
      endpoints: ["/api/uploads"],
      methods: ["POST"],
    },
  ],
  // A 5xx from here still reports even when the server captured it: a server
  // that stopped answering cannot file its own issue.
  probeEndpoints: ["/api/health"],
});

initBeacon({
  // ...
  signals: reliabilitySignalPreset({
    behavioural,
    recoverableSockets: ["/sync"],
  }),
  instrument: {
    resourceErrors: createResourceFailurePolicy({
      thirdPartyHosts: ["googletagmanager.com", "js.stripe.com"],
      optionalPathPrefixes: ["/uploads/"],
    }),
  },
  beforeSend: (event) => (isNoise(event) ? null : event),
});
```

Built in, each switchable and individually exported: hidden-tab read failures,
5xx the server already captured, stale releases the app prompts for itself,
stale chunk imports, theme-extension hydration mismatches, and third-party
deprecation reports. `rules` takes application-specific predicates.

`reliabilitySignalPreset` turns off the four detectors another system usually
already owns — browser policy reports (a `report-to` endpoint is canonical),
document discards, latency (a performance console), stale releases (a service
worker prompt) — and puts the behavioural detectors behind a consent flag.
Everything it does not name keeps its Beacon default.

This entry point imports nothing from the SDK at runtime: boot-time policy is
read by the synchronous page graph, and pulling Beacon's runtime in there makes
the bundler merge the whole SDK back into it, defeating lazy startup.

## License

BSL-1.1 with a named carveout against hosted error-tracking / session-replay
SaaS (Sentry, Datadog, LogRocket). See `LICENSE`.
