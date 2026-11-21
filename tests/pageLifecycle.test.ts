import { expect, test } from "bun:test";
import { observePageLifecycle } from "../src/pageLifecycle";

test("lifecycle distinguishes observed hidden time, bounds history, and detaches", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  const originalNow = performance.now;
  let now = 100;
  let visible = true;
  performance.now = () => now;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  const observer = observePageLifecycle();
  try {
    now = 200;
    visible = false;
    document.dispatchEvent(new Event("visibilitychange"));
    now = 1200;
    const hidden = observer.snapshot();
    expect(hidden.observedHiddenDurationMs).toBe(1000);
    expect(hidden.initialVisibility).toBe("visible");
    now = 2200;
    visible = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(observer.snapshot().observedHiddenDurationMs).toBe(2000);
    for (let i = 0; i < 20; i++)
      document.dispatchEvent(new Event("visibilitychange"));
    expect(observer.snapshot().recentTransitions).toHaveLength(8);
    expect(hidden.recentTransitions).toHaveLength(1);
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
    expect(observer.snapshot().bfcacheRestores).toBe(1);
    observer.close();
    window.dispatchEvent(restored);
    expect(observer.snapshot().bfcacheRestores).toBe(1);
  } finally {
    observer.close();
    performance.now = originalNow;
    if (descriptor)
      Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});
