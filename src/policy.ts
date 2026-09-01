/**
 * Noise policy — which captured signals are real, and which are known-fine.
 *
 * An issue board is only worth opening if everything on it is real. A board
 * that files an application's own SSE stream as a stalled request every shift
 * gets ignored, and the actual breakage gets ignored along with it. So every
 * application that ships Beacon ends up writing the same `beforeSend` filter:
 * a list of named, explained exclusions. In practice most of that list is not
 * application-specific at all — a stale chunk import after a deploy, a theme
 * extension rewriting inline styles before hydration, a read that failed while
 * the tab was hidden, a 5xx the server already captured with a stack. What
 * differs between applications is a handful of endpoints and hostnames.
 *
 * This module is that list, with the endpoints as configuration.
 *
 * It is a separate entry point on purpose, and it imports nothing from the SDK
 * at runtime. Boot-time policy is read by the synchronous page graph; pulling
 * Beacon's runtime constants into that graph makes the bundler merge the whole
 * monitoring SDK back into it, defeating lazy startup. Everything here is
 * plain data and pure functions, and the only imports are types, which erase.
 */
import { BEACON_ATTRIBUTE, BEACON_SIGNAL } from "./contracts";
import type {
  BeaconEvent,
  BeaconResourceFailure,
  BeaconSignals,
} from "./index";

/** Re-exported so a page can read boot-time policy from one import. Both live
 *  in `./contracts`, which pulls in nothing else. */
export { BEACON_ATTRIBUTE, BEACON_SIGNAL };

/** A batched request event covers several endpoints at once, and Beacon marks
 *  the method `multiple` when they did not share one. */
const BATCHED_METHOD = "multiple";

/**
 * One endpoint exemption: a signal raised against a set of endpoints that are
 * known to produce it in normal operation.
 *
 * This is the shape nearly every application-specific rule turns out to have —
 * a stream that stays open for hours, an upload that is megabytes by design, a
 * marketing pixel that fails when a blocker is installed, a request whose
 * client already owns its retry. Naming it once means those rules become four
 * lines of configuration instead of four hand-written predicates.
 */
export type EndpointExemption = {
  /** Signals this exemption applies to. */
  signals: readonly string[];
  /** Endpoints it covers. A string matches as a substring unless `match` says
   *  otherwise; a RegExp is tested against the endpoint. */
  endpoints: readonly (RegExp | string)[];
  /** Restrict to specific request methods. Omit to cover every method. A
   *  batched event (method `multiple`) matches whenever its endpoints do. */
  methods?: readonly string[];
  /** How string patterns are compared. Default `includes`. */
  match?: "exact" | "includes" | "prefix";
};

/**
 * Read the endpoints off an event.
 *
 * Beacon reports a single request on `endpoint` and a batch on `endpoints` as a
 * comma-separated list. Every application that writes one of these rules writes
 * this parser first, usually more than once.
 */
export const eventEndpoints = (tags: BeaconEvent["tags"]): string[] => {
  const batched = tags?.endpoints
    ?.split(",")
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);
  if (batched !== undefined && batched.length > 0) return batched;

  return tags?.endpoint ? [tags.endpoint] : [];
};

const endpointMatches = (
  endpoint: string,
  pattern: RegExp | string,
  match: EndpointExemption["match"],
): boolean => {
  if (typeof pattern !== "string") return pattern.test(endpoint);
  if (match === "exact") return endpoint === pattern;
  if (match === "prefix") return endpoint.startsWith(pattern);

  return endpoint.includes(pattern);
};

/**
 * Whether an event is fully covered by an exemption.
 *
 * Every endpoint has to match, not just one: a batch that mixes the exempt
 * stream with a real request is a real request, and suppressing it would hide
 * the failure behind the stream that happened to travel with it.
 */
export const matchesEndpointExemption = (
  event: Pick<BeaconEvent, "tags">,
  exemption: EndpointExemption,
): boolean => {
  const signal = event.tags?.signal;
  if (signal === undefined || !exemption.signals.includes(signal)) return false;
  const method = event.tags?.method;
  if (
    exemption.methods !== undefined &&
    method !== undefined &&
    method !== BATCHED_METHOD &&
    !exemption.methods.includes(method)
  )
    return false;
  const endpoints = eventEndpoints(event.tags);

  return (
    endpoints.length > 0 &&
    endpoints.every((endpoint) =>
      exemption.endpoints.some((pattern) =>
        endpointMatches(endpoint, pattern, exemption.match),
      ),
    )
  );
};

/**
 * A read that failed while the tab was hidden.
 *
 * A backgrounded tab losing a request is browser lifecycle, not breakage —
 * suspension, a dropped connection, a VPN moving. Applications refetch on
 * focus. Visible failures, writes and timeouts all stay actionable.
 */
export const isHiddenReadFailure = (
  event: Pick<BeaconEvent, "tags">,
): boolean =>
  event.tags?.signal === BEACON_SIGNAL.FETCH_FAILED &&
  event.tags.method === "GET" &&
  event.tags.visibilityState === "hidden" &&
  (event.tags.failureKind === "offline" ||
    event.tags.failureKind === "transport");

/**
 * A 5xx the server already captured.
 *
 * The trace id means a server-side capture exists with the stack, the request
 * and the context. The browser's view of the same failure would open a second
 * issue for one fault, with less in it.
 */
export const isServerCapturedHttpFailure = (
  event: Pick<BeaconEvent, "tags" | "traceId">,
  probeEndpoints: readonly string[] = [],
): boolean => {
  if (
    event.tags?.signal !== BEACON_SIGNAL.HTTP_5XX ||
    event.traceId === undefined
  )
    return false;
  const endpoint = event.tags.endpoint;

  // Cross-origin endpoints have no server-side capture to defer to, and a
  // failing health probe is the one 5xx worth hearing from the browser: it is
  // how an application finds out its own server stopped answering.
  return (
    endpoint?.startsWith("/") === true && !probeEndpoints.includes(endpoint)
  );
};

/**
 * The page is running an older release than this browser has already seen.
 *
 * Applications that prompt for their own updates — a service worker with an
 * update path, a release probe with an `onStale` reload — already tell the
 * person what to do. Reporting it as an issue too is a second voice saying the
 * same thing to someone who cannot act on it.
 */
export const isStaleReleaseSignal = (
  event: Pick<BeaconEvent, "tags">,
): boolean => event.tags?.signal === BEACON_SIGNAL.STALE_RELEASE;

const STALE_CHUNK_IMPORT =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/iu;

/**
 * A dynamic import for a chunk the deploy replaced.
 *
 * The document was served before the release and asks for a file the release
 * renamed. The update path already recovers it, so what is left is a console
 * error that would churn the board on every deploy, once per open tab.
 */
export const isStaleChunkImport = (
  event: Pick<BeaconEvent, "message">,
): boolean => STALE_CHUNK_IMPORT.test(event.message);

const THEME_EXTENSION_INLINE_STYLE = /--(?:darkreader|noir)-inline-/u;

const breadcrumbMessage = (breadcrumb: unknown): string | undefined => {
  if (breadcrumb === null || typeof breadcrumb !== "object") return undefined;
  const message = Reflect.get(breadcrumb, "message");

  return typeof message === "string" ? message : undefined;
};

/**
 * A hydration mismatch caused by a page-recolouring extension.
 *
 * Dark Reader and its kind rewrite inline styles before the framework hydrates,
 * and the framework correctly reports that the markup it found is not the
 * markup it rendered. The edit is the extension's, made in a browser the
 * application will never see, and no change to the application removes it.
 */
export const isThemeExtensionHydrationNoise = (
  event: Pick<BeaconEvent, "extra" | "message">,
): boolean => {
  if (event.message !== "Hydration completed but contains mismatches.")
    return false;
  const breadcrumbs = event.extra?.breadcrumbs;

  return (
    Array.isArray(breadcrumbs) &&
    breadcrumbs.some((breadcrumb) =>
      THEME_EXTENSION_INLINE_STYLE.test(breadcrumbMessage(breadcrumb) ?? ""),
    )
  );
};

/**
 * A browser deprecation report for something the page does not control.
 *
 * A third-party tag's own deprecation is attributed to the document that hosts
 * it. Naming the report identities that are known to come from outside keeps
 * the ones from application code actionable.
 */
export const isExternalBrowserDeprecation = (
  event: Pick<BeaconEvent, "tags">,
  reportIdentities: readonly string[],
): boolean =>
  event.tags?.signal === BEACON_SIGNAL.BROWSER_POLICY_VIOLATION &&
  event.tags.reportType === "deprecation" &&
  reportIdentities.includes(event.tags.policyId ?? "");

/** Google's Attribution Reporting deprecation, emitted by the ads and
 *  analytics tags rather than by the page that embeds them. */
export const ATTRIBUTION_REPORTING_DEPRECATION = "AttributionReporting";

export type NoisePolicyOptions = {
  /**
   * Endpoints that are known to raise a signal in normal operation: streams
   * that stay open, uploads that are large by design, pixels that a blocker
   * refuses, requests whose client owns its own retry.
   */
  exemptions?: readonly EndpointExemption[];
  /**
   * Health/readiness endpoints. A 5xx from one of these still reports even
   * when a trace id says the server captured it, because a server that has
   * stopped answering cannot be relied on to file its own issue.
   */
  probeEndpoints?: readonly string[];
  /** Browser report identities known to originate outside the page. Defaults
   *  to Attribution Reporting; pass `[]` to keep every deprecation. */
  externalDeprecations?: readonly string[];
  /** The application prompts for its own updates. Default true. */
  ownsReleaseUpdates?: boolean;
  /** Suppress hidden-tab read failures. Default true. */
  ignoreHiddenReadFailures?: boolean;
  /** Suppress 5xx the server already captured. Default true. */
  ignoreServerCapturedFailures?: boolean;
  /** Suppress dynamic imports for chunks a deploy replaced. Default true. */
  ignoreStaleChunkImports?: boolean;
  /** Suppress hydration mismatches written by theme extensions. Default true. */
  ignoreThemeExtensionHydration?: boolean;
  /** Application-specific rules, run after the built-in ones. */
  rules?: readonly ((event: BeaconEvent) => boolean)[];
};

/**
 * Build the `beforeSend` predicate.
 *
 * Returns true for an event that should be dropped, so a caller reads as
 * `beforeSend: (event) => (isNoise(event) ? null : event)`.
 */
export const createNoisePolicy = (options: NoisePolicyOptions = {}) => {
  const {
    exemptions = [],
    externalDeprecations = [ATTRIBUTION_REPORTING_DEPRECATION],
    ignoreHiddenReadFailures = true,
    ignoreServerCapturedFailures = true,
    ignoreStaleChunkImports = true,
    ignoreThemeExtensionHydration = true,
    ownsReleaseUpdates = true,
    probeEndpoints = [],
    rules = [],
  } = options;

  return (event: BeaconEvent): boolean =>
    (ownsReleaseUpdates && isStaleReleaseSignal(event)) ||
    (ignoreStaleChunkImports && isStaleChunkImport(event)) ||
    (ignoreThemeExtensionHydration && isThemeExtensionHydrationNoise(event)) ||
    (ignoreHiddenReadFailures && isHiddenReadFailure(event)) ||
    (ignoreServerCapturedFailures &&
      isServerCapturedHttpFailure(event, probeEndpoints)) ||
    (externalDeprecations.length > 0 &&
      isExternalBrowserDeprecation(event, externalDeprecations)) ||
    exemptions.some((exemption) =>
      matchesEndpointExemption(event, exemption),
    ) ||
    rules.some((rule) => rule(event));
};

export type ResourceFailurePolicyOptions = {
  /** Hostnames whose scripts are not the application's to fix. A pattern
   *  matches the hostname itself or any subdomain of it. */
  thirdPartyHosts?: readonly string[];
  /** Cross-origin images are optional by default: the elements that show them
   *  render a placeholder, and the remote host is not the application's to
   *  fix. Set false to treat a missing remote image as an error. */
  optionalCrossOriginImages?: boolean;
  /** Same-origin path prefixes serving optional imagery — an avatar, a logo
   *  proxy, an uploaded thumbnail — where a placeholder already stands in. */
  optionalPathPrefixes?: readonly string[];
};

const hostMatches = (hostname: string, pattern: string): boolean =>
  hostname === pattern || hostname.endsWith(`.${pattern}`);

/**
 * Split a failed resource's URL into the two parts these rules ask about.
 *
 * An absolute URL carries its own host and needs no base. A relative one is
 * same-origin by construction, and its path is the characters before any query
 * — which is worth extracting directly, because the contexts this runs in do
 * not all have a resolvable `location`: a worker, a server render, or a test
 * DOM parked on `about:blank`. Falling back to "unparseable" there would
 * quietly disable the path rules in exactly the places hardest to notice.
 */
const parseFailureUrl = (
  url: string,
): { hostname: string; pathname: string } | undefined => {
  try {
    return new URL(url);
  } catch {
    // Relative; fall through.
  }
  const base = typeof location === "undefined" ? undefined : location.href;
  if (base !== undefined)
    try {
      return new URL(url, base);
    } catch {
      // Unusable base; fall through to the path-only reading.
    }

  return url.startsWith("/")
    ? { hostname: "", pathname: url.split(/[?#]/u)[0] ?? url }
    : undefined;
};

/**
 * Which failed resources are errors.
 *
 * A third-party analytics script blocked by an extension and a customer's
 * uploaded thumbnail 404ing are not the application being broken — the first is
 * not the application's code to fix, and the second already renders a
 * placeholder. Its own scripts, styles and images still are.
 *
 * Returns Beacon's `resourceErrors` classifier: a level to report at, or false
 * to ignore.
 */
export const createResourceFailurePolicy = (
  options: ResourceFailurePolicyOptions = {},
) => {
  const {
    optionalCrossOriginImages = true,
    optionalPathPrefixes = [],
    thirdPartyHosts = [],
  } = options;

  return (failure: BeaconResourceFailure): "error" | false => {
    if (failure.url === undefined) return "error";
    // An unreadable URL is not evidence that the resource was optional, so it
    // reports rather than disappearing.
    const parsed = parseFailureUrl(failure.url);
    if (parsed === undefined) return "error";
    if (
      failure.type === "script" &&
      thirdPartyHosts.some((host) => hostMatches(parsed.hostname, host))
    )
      return false;
    if (failure.type !== "img") return "error";
    if (optionalCrossOriginImages && failure.crossOrigin) return false;

    return optionalPathPrefixes.some((prefix) =>
      parsed.pathname.startsWith(prefix),
    )
      ? false
      : "error";
  };
};

export type ReliabilityPresetOptions = {
  /**
   * Behavioural detectors watch a person rather than a page — what they
   * clicked, where they got stuck — so they belong on the same consent
   * boundary as session replay. Structural health stays on for everyone.
   */
  behavioural?: boolean;
  /** A `report-to` endpoint already delivers browser policy reports, so the
   *  parallel observer would file each deprecation twice. Default true. */
  hasReportingEndpoint?: boolean;
  /** A Performance console owns ordinary latency, so error triage keeps only
   *  failures. Default true. */
  ownsLatencyElsewhere?: boolean;
  /** The application prompts for its own updates. Default true. */
  ownsReleaseUpdates?: boolean;
  /** Documents are restored from server state on boot, so a browser evicting
   *  a tab to reclaim memory is not a fault. Default true. */
  restoresFromServerState?: boolean;
  /** Endpoints whose client owns reconnect and resume. */
  recoverableSockets?: Array<RegExp | string>;
  /** bfcache blockers inherent to a capability the application requires. */
  ignoredBfcacheReasons?: string[];
};

/**
 * The signal set an application with its own error triage usually wants.
 *
 * Beacon enables every detector by default, which is right for an application
 * that has nothing else. One that also runs a Performance console, a release
 * probe and a Reporting API endpoint has to turn the same four off, for the
 * same reasons, every time — otherwise each of those systems files the issue
 * its neighbour already filed. Everything not named here keeps its default.
 */
export const reliabilitySignalPreset = (
  options: ReliabilityPresetOptions = {},
): BeaconSignals => {
  const {
    behavioural = false,
    hasReportingEndpoint = true,
    ignoredBfcacheReasons,
    ownsLatencyElsewhere = true,
    ownsReleaseUpdates = true,
    recoverableSockets,
    restoresFromServerState = true,
  } = options;

  return {
    browserPolicyViolations: !hasReportingEndpoint,
    deadClicks: behavioural,
    documentDiscards: !restoresFromServerState,
    errorClicks: behavioural,
    formAbandonment: behavioural,
    formFrustration: behavioural,
    ...(ignoredBfcacheReasons ? { ignoredBfcacheReasons } : {}),
    rageClicks: behavioural,
    ...(recoverableSockets ? { recoverableSockets } : {}),
    scrollJail: behavioural,
    slowInteractions: !ownsLatencyElsewhere,
    slowResponses: !ownsLatencyElsewhere,
    staleReleases: !ownsReleaseUpdates,
    thrashedCursors: behavioural,
  };
};
