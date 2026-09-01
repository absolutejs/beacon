/**
 * Noise policy tests.
 *
 * Each case is a rule that a real application wrote by hand before this module
 * existed, plus the case that rule must not swallow — a suppression that is
 * slightly too wide is worse than no suppression at all, because the board
 * still looks clean while the failure it hid goes unreported.
 */
import { describe, expect, test } from "bun:test";
import type { BeaconEvent } from "../src/index";
import {
  ATTRIBUTION_REPORTING_DEPRECATION,
  BEACON_SIGNAL,
  createNoisePolicy,
  createResourceFailurePolicy,
  eventEndpoints,
  isHiddenReadFailure,
  isServerCapturedHttpFailure,
  isStaleChunkImport,
  isThemeExtensionHydrationNoise,
  matchesEndpointExemption,
  reliabilitySignalPreset,
} from "../src/policy";

const event = (over: Partial<BeaconEvent> = {}): BeaconEvent => ({
  message: "boom",
  name: "Error",
  ...over,
});

describe("eventEndpoints", () => {
  test("reads a single endpoint", () => {
    expect(eventEndpoints({ endpoint: "/sync" })).toEqual(["/sync"]);
  });

  test("splits a batch and trims it", () => {
    expect(eventEndpoints({ endpoints: "/sync, /stream ,/api/x" })).toEqual([
      "/sync",
      "/stream",
      "/api/x",
    ]);
  });

  test("is empty when neither tag is set", () => {
    expect(eventEndpoints(undefined)).toEqual([]);
    expect(eventEndpoints({ signal: BEACON_SIGNAL.FETCH_FAILED })).toEqual([]);
  });
});

describe("matchesEndpointExemption", () => {
  const streams = {
    endpoints: ["/sync", "/stream"],
    signals: [BEACON_SIGNAL.SLOW_RESPONSE, BEACON_SIGNAL.FETCH_FAILED],
  };

  test("exempts a stream that is open by design", () => {
    expect(
      matchesEndpointExemption(
        {
          tags: {
            endpoint: "/sync/orders",
            signal: BEACON_SIGNAL.SLOW_RESPONSE,
          },
        },
        streams,
      ),
    ).toBe(true);
  });

  test("does not exempt a batch that also carries a real request", () => {
    expect(
      matchesEndpointExemption(
        {
          tags: {
            endpoints: "/sync,/api/checkout",
            signal: BEACON_SIGNAL.FETCH_FAILED,
          },
        },
        streams,
      ),
    ).toBe(false);
  });

  test("respects the signal it was written for", () => {
    expect(
      matchesEndpointExemption(
        { tags: { endpoint: "/sync", signal: BEACON_SIGNAL.HTTP_5XX } },
        streams,
      ),
    ).toBe(false);
  });

  test("restricts by method, and a batched method still matches", () => {
    const uploads = {
      endpoints: ["/api/upload"],
      methods: ["POST"],
      signals: [BEACON_SIGNAL.SLOW_RESPONSE],
    };
    expect(
      matchesEndpointExemption(
        {
          tags: {
            endpoint: "/api/upload",
            method: "GET",
            signal: BEACON_SIGNAL.SLOW_RESPONSE,
          },
        },
        uploads,
      ),
    ).toBe(false);
    expect(
      matchesEndpointExemption(
        {
          tags: {
            endpoints: "/api/upload,/api/upload/finish",
            method: "multiple",
            signal: BEACON_SIGNAL.SLOW_RESPONSE,
          },
        },
        uploads,
      ),
    ).toBe(true);
  });

  test("matches exactly and by regexp when asked", () => {
    expect(
      matchesEndpointExemption(
        {
          tags: {
            endpoint: "/ccm/collect",
            signal: BEACON_SIGNAL.FETCH_FAILED,
          },
        },
        {
          endpoints: [/^\/ccm(?:\/s)?\/collect$/u],
          signals: [BEACON_SIGNAL.FETCH_FAILED],
        },
      ),
    ).toBe(true);
    expect(
      matchesEndpointExemption(
        {
          tags: {
            endpoint: "/v1/tutorials/active/extra",
            signal: BEACON_SIGNAL.FETCH_FAILED,
          },
        },
        {
          endpoints: ["/v1/tutorials/active"],
          match: "exact",
          signals: [BEACON_SIGNAL.FETCH_FAILED],
        },
      ),
    ).toBe(false);
  });
});

describe("built-in rules", () => {
  test("a hidden-tab read failure is lifecycle, a visible one is not", () => {
    const tags = {
      failureKind: "transport",
      method: "GET",
      signal: BEACON_SIGNAL.FETCH_FAILED,
    };
    expect(
      isHiddenReadFailure({ tags: { ...tags, visibilityState: "hidden" } }),
    ).toBe(true);
    expect(
      isHiddenReadFailure({ tags: { ...tags, visibilityState: "visible" } }),
    ).toBe(false);
    expect(
      isHiddenReadFailure({
        tags: { ...tags, method: "POST", visibilityState: "hidden" },
      }),
    ).toBe(false);
  });

  test("a 5xx with a trace id defers to the server, but not from a probe", () => {
    const tags = { endpoint: "/api/orders", signal: BEACON_SIGNAL.HTTP_5XX };
    expect(isServerCapturedHttpFailure({ tags, traceId: "t1" })).toBe(true);
    expect(isServerCapturedHttpFailure({ tags })).toBe(false);
    expect(
      isServerCapturedHttpFailure(
        {
          tags: { endpoint: "/api/health", signal: BEACON_SIGNAL.HTTP_5XX },
          traceId: "t1",
        },
        ["/api/health"],
      ),
    ).toBe(false);
    expect(
      isServerCapturedHttpFailure({
        tags: {
          endpoint: "https://api.example.com/x",
          signal: BEACON_SIGNAL.HTTP_5XX,
        },
        traceId: "t1",
      }),
    ).toBe(false);
  });

  test("a stale chunk import is recognised in each browser's wording", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://x/y.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
    ])
      expect(isStaleChunkImport({ message })).toBe(true);
    expect(isStaleChunkImport({ message: "Failed to fetch" })).toBe(false);
  });

  test("a hydration mismatch is the extension's only with its fingerprint", () => {
    const message = "Hydration completed but contains mismatches.";
    expect(
      isThemeExtensionHydrationNoise({
        extra: {
          breadcrumbs: [{ message: "style --darkreader-inline-bgcolor set" }],
        },
        message,
      }),
    ).toBe(true);
    expect(
      isThemeExtensionHydrationNoise({
        extra: { breadcrumbs: [{ message: "clicked Add to cart" }] },
        message,
      }),
    ).toBe(false);
  });
});

describe("createNoisePolicy", () => {
  const isNoise = createNoisePolicy({
    exemptions: [
      {
        endpoints: ["/sync", "/stream"],
        signals: [BEACON_SIGNAL.SLOW_RESPONSE, BEACON_SIGNAL.FETCH_FAILED],
      },
    ],
    probeEndpoints: ["/api/health"],
  });

  test("drops what the application already handles", () => {
    expect(
      isNoise(event({ tags: { signal: BEACON_SIGNAL.STALE_RELEASE } })),
    ).toBe(true);
    expect(
      isNoise(
        event({
          tags: { endpoint: "/stream", signal: BEACON_SIGNAL.SLOW_RESPONSE },
        }),
      ),
    ).toBe(true);
    expect(
      isNoise(
        event({
          tags: {
            policyId: ATTRIBUTION_REPORTING_DEPRECATION,
            reportType: "deprecation",
            signal: BEACON_SIGNAL.BROWSER_POLICY_VIOLATION,
          },
        }),
      ),
    ).toBe(true);
  });

  test("keeps an ordinary failure", () => {
    expect(
      isNoise(
        event({
          tags: {
            endpoint: "/api/checkout",
            signal: BEACON_SIGNAL.FETCH_FAILED,
          },
        }),
      ),
    ).toBe(false);
    expect(isNoise(event({ message: "Cannot read properties of null" }))).toBe(
      false,
    );
  });

  test("a health probe's 5xx still reports", () => {
    expect(
      isNoise(
        event({
          tags: { endpoint: "/api/health", signal: BEACON_SIGNAL.HTTP_5XX },
          traceId: "t1",
        }),
      ),
    ).toBe(false);
  });

  test("built-in rules can be turned off, and extra rules added", () => {
    const keepsChunks = createNoisePolicy({ ignoreStaleChunkImports: false });
    expect(
      keepsChunks(
        event({ message: "Failed to fetch dynamically imported module" }),
      ),
    ).toBe(false);
    const custom = createNoisePolicy({
      rules: [(candidate) => candidate.name === "VendorError"],
    });
    expect(custom(event({ name: "VendorError" }))).toBe(true);
  });
});

describe("createResourceFailurePolicy", () => {
  const level = createResourceFailurePolicy({
    optionalPathPrefixes: ["/uploads/"],
    thirdPartyHosts: ["googletagmanager.com"],
  });

  test("a third-party tag is not the application's to fix", () => {
    expect(
      level({
        crossOrigin: true,
        target: "script",
        type: "script",
        url: "https://www.googletagmanager.com/gtag/js",
      }),
    ).toBe(false);
  });

  test("the application's own script is", () => {
    expect(
      level({
        crossOrigin: false,
        target: "script",
        type: "script",
        url: "/assets/app.js",
      }),
    ).toBe("error");
  });

  test("optional imagery falls back, wherever it is served from", () => {
    expect(
      level({
        crossOrigin: true,
        target: "img",
        type: "img",
        url: "https://cdn.example.com/a.png",
      }),
    ).toBe(false);
    expect(
      level({
        crossOrigin: false,
        target: "img",
        type: "img",
        url: "/uploads/artwork/1.png",
      }),
    ).toBe(false);
    expect(
      level({
        crossOrigin: false,
        target: "img",
        type: "img",
        url: "/logo.svg",
      }),
    ).toBe("error");
  });

  test("a resource with no url is reported rather than assumed optional", () => {
    expect(level({ crossOrigin: false, target: "img", type: "img" })).toBe(
      "error",
    );
  });
});

describe("reliabilitySignalPreset", () => {
  test("turns off exactly the detectors another system already owns", () => {
    const signals = reliabilitySignalPreset({ recoverableSockets: ["/sync"] });
    expect(signals.browserPolicyViolations).toBe(false);
    expect(signals.documentDiscards).toBe(false);
    expect(signals.slowResponses).toBe(false);
    expect(signals.slowInteractions).toBe(false);
    expect(signals.staleReleases).toBe(false);
    expect(signals.recoverableSockets).toEqual(["/sync"]);
  });

  test("behavioural detectors follow consent", () => {
    expect(reliabilitySignalPreset().rageClicks).toBe(false);
    expect(reliabilitySignalPreset({ behavioural: true }).rageClicks).toBe(
      true,
    );
  });

  test("an application without those systems keeps the detectors", () => {
    const signals = reliabilitySignalPreset({
      hasReportingEndpoint: false,
      ownsLatencyElsewhere: false,
      ownsReleaseUpdates: false,
      restoresFromServerState: false,
    });
    expect(signals.browserPolicyViolations).toBe(true);
    expect(signals.slowResponses).toBe(true);
    expect(signals.staleReleases).toBe(true);
    expect(signals.documentDiscards).toBe(true);
  });

  test("leaves untouched detectors at their Beacon defaults", () => {
    expect("consoleErrors" in reliabilitySignalPreset()).toBe(false);
  });
});
