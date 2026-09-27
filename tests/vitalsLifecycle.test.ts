import { expect, test } from "bun:test";
import {
  createBeacon,
  type WebVital,
  type WebVitalsModule,
} from "../src/index";

type WebVitalMetric = Parameters<Parameters<WebVitalsModule["onLCP"]>[0]>[0];

const instrument = {
  clicks: false,
  console: false,
  fetch: false,
  globalErrors: false,
  history: false,
  unhandledRejections: false,
} as const;

test("closing Beacon disconnects TBT and ignores late vital delivery", async () => {
  const original = globalThis.PerformanceObserver;
  let disconnected = false;
  let report: ((metric: WebVitalMetric) => void) | undefined;
  class Observer {
    observe() {}
    disconnect() {
      disconnected = true;
    }
    takeRecords() {
      return [];
    }
  }
  globalThis.PerformanceObserver =
    Observer as unknown as typeof PerformanceObserver;
  const vitals: WebVital[] = [];
  const ignore = () => {};
  const beacon = createBeacon({
    project: "lifecycle",
    instrument,
    vitals: {
      transport: (v) => {
        vitals.push(v);
      },
      webVitals: {
        onCLS: ignore,
        onFCP: ignore,
        onINP: ignore,
        onLCP: (callback) => {
          report = callback;
        },
        onTTFB: ignore,
      },
    },
  });
  try {
    await beacon.close();
    expect(disconnected).toBe(true);
    report?.({
      id: "late",
      name: "LCP",
      value: 10,
      rating: "good",
      navigationType: "navigate",
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(vitals).toHaveLength(0);
  } finally {
    await beacon.close();
    globalThis.PerformanceObserver = original;
  }
});

test("TBT finalizes its bounded window, drains pending records and stops observing", async () => {
  const originalObserver = globalThis.PerformanceObserver;
  const originalNow = performance.now;
  const originalEntries = performance.getEntriesByName;
  const originalTimeout = globalThis.setTimeout;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let now = 0;
  let disconnected = false;
  let pending: PerformanceEntry[] = [
    { duration: 100, startTime: 500 },
    { duration: 2000, startTime: 15000 },
  ] as PerformanceEntry[];
  performance.now = () => now;
  performance.getEntriesByName = () =>
    [{ startTime: 100 }] as PerformanceEntry[];
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    timers.push({ callback, delay });
    return 0;
  }) as unknown as typeof setTimeout;
  class Observer {
    observe() {}
    disconnect() {
      disconnected = true;
    }
    takeRecords() {
      const result = pending;
      pending = [];
      return result;
    }
  }
  globalThis.PerformanceObserver =
    Observer as unknown as typeof PerformanceObserver;
  const vitals: WebVital[] = [];
  const ignore = () => {};
  const beacon = createBeacon({
    project: "window",
    instrument,
    vitals: {
      transport: (v) => {
        vitals.push(v);
      },
      webVitals: {
        onCLS: ignore,
        onFCP: ignore,
        onINP: ignore,
        onLCP: ignore,
        onTTFB: ignore,
      },
    },
  });
  try {
    const timer = timers.find((t) => t.delay === 10100);
    expect(timer).toBeDefined();
    now = 10100;
    timer?.callback();
    expect(disconnected).toBe(true);
    expect(vitals).toHaveLength(1);
    expect(vitals[0]).toMatchObject({ name: "TBT", value: 50 });
    window.dispatchEvent(new Event("pagehide"));
    expect(vitals).toHaveLength(1);
  } finally {
    await beacon.close();
    globalThis.PerformanceObserver = originalObserver;
    performance.now = originalNow;
    performance.getEntriesByName = originalEntries;
    globalThis.setTimeout = originalTimeout;
  }
});
