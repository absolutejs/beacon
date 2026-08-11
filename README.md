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
- **Ambient watchdogs** — silent failures users abandon instead of reporting
  become warning issues: scroll jail (a leaked modal scroll lock), stuck
  loading (`aria-busy`/`role="progressbar"` that never resolves), occluded
  controls (leaked scrims/z-index bugs, skipped while a dialog is open),
  invisible text (fg composites to its background — theme-token bugs),
  stalled `EventSource` streams, WebSocket connect/close flapping, request
  storms (one endpoint hammered in seconds), reload loops, stale releases (a
  service worker serving a build older than one this browser already ran),
  font-face load failures, focus dropped to `<body>` when a dialog unmounts,
  focus escaping or never entering an explicit modal, browser interventions,
  enforced CSP violations, repeated visible-page main-thread stalls, and form
  frustration (identical resubmits / repeated native-validation failures).
  Each is individually toggleable on `signals`, deduped, capped, and exempts
  `data-beacon-scan="allow"` subtrees where a DOM scan is involved.
  Reload loops require repeated loads of the same normalized route; ordinary
  navigation across several pages does not qualify. Occlusion scans exclude
  hidden, inert, transparent, and pointer-disabled control subtrees.
- **Theme and loading contracts** — mark an application boundary with
  `data-beacon-theme="adaptive"` to report large opaque surfaces whose
  luminance polarity contradicts the active light/dark mode. Intentional
  inverted brand/media surfaces use `data-beacon-theme="allow"`. Loading UI
  participates through native `aria-busy`/`role="progressbar"` semantics or
  `data-beacon-loading`, without coupling the SDK to framework class names.
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
  reconnect flapping, handled service-worker registration/install failures, and
  dedicated/shared worker construction, runtime, and message-decoding failures
  become replay-linked warnings. Normal socket closes, page teardown, hidden-tab
  SSE errors, and successfully replaced service workers are exempt.
- **Attributed reliability signals** — Event Timing identifies genuinely slow
  interactions and separates input delay, handler time, and presentation delay.
  Overlapping long animation frames include their worst script when the browser
  exposes it; missing browser attribution is labeled explicitly. Layout
  Instability names shifted elements. Successful HTTP responses can be
  classified through the host-owned `instrument.classifyResponse` callback for
  GraphQL-style errors without Beacon retaining response bodies.
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
BEACON_TRACE_HEADER // "x-absolute-trace-id"

// Global helpers (no-op until initBeacon): captureException, captureMessage,
// addBreadcrumb, observeCapability
```

SSR-safe: imported in a non-DOM environment, `createBeacon` returns a no-op.

Semantic grouping keys require `@absolutejs/errors` 0.7.3 or newer at the
ingest boundary.

## License

BSL-1.1 with a named carveout against hosted error-tracking / session-replay
SaaS (Sentry, Datadog, LogRocket). See `LICENSE`.
