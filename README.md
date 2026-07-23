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
- **Cause chains** — preserves nested `Error.cause` stacks and diagnostic fields
  in `extra.errorCauses`, including database driver error codes and details.
- **Sampling + redaction** — `sampleRate` and a `beforeSend(event)` hook
  (return `null` to drop).
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
  automatically. Controls marked active through `aria-current`, `aria-pressed`,
  or `aria-selected` are excluded because clicking the already-current state is
  an intentional no-op; semantic anchors remain preferred for navigation.
- **Actionable network signals** — expected aborts remain breadcrumbs instead of
  issues; offline, timeout, isolated-endpoint, and multi-endpoint connectivity
  failures are classified separately. Concurrent failures become one event with
  every attempt, method, endpoint, duration, original error/stack, online state,
  transport, and page visibility preserved in `extra.networkFailures`.

## API

```ts
createBeacon(options) => Beacon
initBeacon(options)   => Beacon   // also sets the global singleton
getBeacon()           => Beacon | undefined

// Beacon:
captureException(error, { level?, traceId?, spanId?, tags?, extra? })
captureMessage(message, level?)
addBreadcrumb({ message, type?, data? })
setTags(tags) · setUser(user | null)
flush() => Promise<void>          // buffered events out now
close() => Promise<void>          // remove listeners + final flush

// Typed names for event.tags.signal in beforeSend policies:
BEACON_SIGNAL.FETCH_FAILED
BEACON_SIGNAL.SLOW_RESPONSE
BEACON_SIGNAL.HTTP_5XX
BEACON_TRACE_HEADER // "x-absolute-trace-id"

// Global helpers (no-op until initBeacon): captureException, captureMessage, addBreadcrumb
```

SSR-safe: imported in a non-DOM environment, `createBeacon` returns a no-op.

## License

BSL-1.1 with a named carveout against hosted error-tracking / session-replay
SaaS (Sentry, Datadog, LogRocket). See `LICENSE`.
