/** Lightweight pre-hydration layout-shift recorder. */

export type EarlyLayoutShiftRect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
  x: number;
  y: number;
};

export type EarlyLayoutShiftViewport = {
  documentHeight: number;
  documentWidth: number;
  innerHeight: number;
  innerWidth: number;
  visualHeight?: number;
  visualOffsetLeft?: number;
  visualOffsetTop?: number;
  visualScale?: number;
  visualWidth?: number;
};

export type EarlyLayoutShiftSource = {
  currentRect?: EarlyLayoutShiftRect;
  node?: Node;
  previousRect?: EarlyLayoutShiftRect;
  target: string;
};

export type EarlyLayoutShiftEntry = {
  documentReadyState: DocumentReadyState;
  hadRecentInput: boolean;
  observedAt: number;
  sources: EarlyLayoutShiftSource[];
  startTime: number;
  value: number;
  viewport: EarlyLayoutShiftViewport;
};

export type EarlyLayoutShiftBuffer = {
  entries: EarlyLayoutShiftEntry[];
  interactionTimes: number[];
  observerStartedAt: number;
  resizeTimes: number[];
};

type LayoutShiftSourceLike = {
  currentRect?: DOMRectReadOnly;
  node?: Node | null;
  previousRect?: DOMRectReadOnly;
};
type LayoutShiftEntryLike = PerformanceEntry & {
  hadRecentInput?: boolean;
  sources?: LayoutShiftSourceLike[];
  value?: number;
};
type InstalledEarlyLayoutShiftBuffer = EarlyLayoutShiftBuffer & {
  cleanup: () => void;
  observer: PerformanceObserver;
  recordEntries: (entries: PerformanceEntry[]) => void;
};

declare global {
  interface Window {
    __absoluteBeaconEarlyLayoutShift?: InstalledEarlyLayoutShiftBuffer;
  }
}

const HISTORY_LIMIT = 16;
const ENTRY_LIMIT = 50;
const now = (): number =>
  typeof performance === "undefined" ? 0 : performance.now();

const describeNode = (node: Node | null | undefined): string => {
  if (!(node instanceof Element)) return "unknown";
  const id = node.id === "" ? "" : `#${node.id}`;
  const classes = [...node.classList]
    .slice(0, 3)
    .map((name) => `.${name}`)
    .join("");
  return `${node.tagName.toLowerCase()}${id}${classes}`;
};

const copyRect = (
  rect: DOMRectReadOnly | undefined,
): EarlyLayoutShiftRect | undefined =>
  rect === undefined
    ? undefined
    : {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      };

const viewportSnapshot = (): EarlyLayoutShiftViewport => {
  const visual = window.visualViewport;
  return {
    documentHeight: document.documentElement.scrollHeight,
    documentWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    ...(visual == null
      ? {}
      : {
          visualHeight: visual.height,
          visualOffsetLeft: visual.offsetLeft,
          visualOffsetTop: visual.offsetTop,
          visualScale: visual.scale,
          visualWidth: visual.width,
        }),
  };
};

const appendLimited = (values: number[], value: number): void => {
  values.push(value);
  if (values.length > HISTORY_LIMIT)
    values.splice(0, values.length - HISTORY_LIMIT);
};

/** Install once from the application's synchronous entry module. SSR-safe. */
export const installEarlyLayoutShiftBuffer = (): void => {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof PerformanceObserver === "undefined" ||
    window.__absoluteBeaconEarlyLayoutShift !== undefined
  )
    return;

  const interactionTimes: number[] = [];
  const resizeTimes: number[] = [];
  const entries: EarlyLayoutShiftEntry[] = [];
  const recordInteraction = (): void => appendLimited(interactionTimes, now());
  const recordResize = (): void => appendLimited(resizeTimes, now());
  const recordEntries = (rawEntries: PerformanceEntry[]): void => {
    for (const raw of rawEntries) {
      const entry = raw as LayoutShiftEntryLike;
      entries.push({
        documentReadyState: document.readyState,
        hadRecentInput: entry.hadRecentInput === true,
        observedAt: now(),
        sources: (entry.sources ?? []).slice(0, 5).map((source) => ({
          ...(source.currentRect === undefined
            ? {}
            : { currentRect: copyRect(source.currentRect) }),
          ...(source.node === undefined || source.node === null
            ? {}
            : { node: source.node }),
          ...(source.previousRect === undefined
            ? {}
            : { previousRect: copyRect(source.previousRect) }),
          target: describeNode(source.node),
        })),
        startTime: entry.startTime,
        value: entry.value ?? 0,
        viewport: viewportSnapshot(),
      });
    }
    if (entries.length > ENTRY_LIMIT)
      entries.splice(0, entries.length - ENTRY_LIMIT);
  };

  try {
    const observerStartedAt = now();
    const observer = new PerformanceObserver((list) =>
      recordEntries(list.getEntries()),
    );
    const interactionEvents = [
      "click",
      "keydown",
      "pointerdown",
      "submit",
    ] as const;
    observer.observe({ buffered: true, type: "layout-shift" });
    for (const event of interactionEvents)
      window.addEventListener(event, recordInteraction, true);
    window.addEventListener("resize", recordResize);
    window.visualViewport?.addEventListener("resize", recordResize);
    const cleanup = (): void => {
      for (const event of interactionEvents)
        window.removeEventListener(event, recordInteraction, true);
      window.removeEventListener("resize", recordResize);
      window.visualViewport?.removeEventListener("resize", recordResize);
    };
    window.__absoluteBeaconEarlyLayoutShift = {
      cleanup,
      entries,
      interactionTimes,
      observer,
      observerStartedAt,
      recordEntries,
      resizeTimes,
    };
  } catch {
    // Unsupported browsers must not have their startup affected by telemetry.
  }
};

/** Consume and remove the pre-hydration recorder, if one was installed. */
export const consumeEarlyLayoutShiftBuffer = ():
  EarlyLayoutShiftBuffer | undefined => {
  if (typeof window === "undefined") return undefined;
  const installed = window.__absoluteBeaconEarlyLayoutShift;
  if (installed === undefined) return undefined;
  installed.recordEntries(installed.observer.takeRecords());
  installed.observer.disconnect();
  installed.cleanup();
  delete window.__absoluteBeaconEarlyLayoutShift;
  return {
    entries: installed.entries,
    interactionTimes: installed.interactionTimes,
    observerStartedAt: installed.observerStartedAt,
    resizeTimes: installed.resizeTimes,
  };
};
