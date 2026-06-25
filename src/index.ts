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
  /** Override the wire transport (default: sendBeacon / fetch keepalive). */
  transport?: BeaconTransport;
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
        original.apply(console, args);
      };
      cleanups.push(() => {
        console[method] = original;
      });
    }
  }

  if (instrument.clicks !== false && typeof document !== "undefined") {
    const onClick = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element) {
        addBreadcrumb({ message: describeElement(target), type: "click" });
      }
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
      try {
        const response = await originalFetch(...args);
        addBreadcrumb({
          data: { status: response.status },
          message: `${method} ${url} → ${response.status}`,
          type: "fetch",
        });
        return response;
      } catch (error) {
        addBreadcrumb({ message: `${method} ${url} → failed`, type: "fetch" });
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
