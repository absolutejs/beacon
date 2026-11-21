/** Bounded, content-free context. Times are relative to SDK observation, not
 * evidence of visibility before the SDK started. No timer or extra requests. */
export const observePageLifecycle = () => {
  const started = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const visibility = () =>
    document.visibilityState === "visible"
      ? "visible"
      : document.visibilityState === "hidden"
        ? "hidden"
        : "unknown";
  const initialVisibility = visibility();
  let state = initialVisibility;
  let hiddenAt: number | undefined = state === "hidden" ? 0 : undefined;
  let hiddenDurationMs = 0;
  let visibilityChanges = 0;
  let bfcacheRestores = 0;
  let pageHidden = false;
  const recentTransitions: Array<{
    kind: string;
    atMs: number;
    visibility: string;
    persisted?: boolean;
  }> = [];
  const record = (kind: string, persisted?: boolean) => {
    const atMs = elapsed();
    const next = visibility();
    if (next !== state) {
      visibilityChanges = Math.min(visibilityChanges + 1, 1_000_000);
      if (hiddenAt !== undefined)
        hiddenDurationMs += Math.max(0, atMs - hiddenAt);
      hiddenAt = next === "hidden" ? atMs : undefined;
      state = next;
    }
    recentTransitions.push({
      kind,
      atMs,
      visibility: state,
      ...(persisted === undefined ? {} : { persisted }),
    });
    if (recentTransitions.length > 8) recentTransitions.shift();
  };
  const onVisibility = () => record("visibilitychange");
  const onHide = (event: PageTransitionEvent) => {
    pageHidden = true;
    record("pagehide", event.persisted === true);
  };
  const onShow = (event: PageTransitionEvent) => {
    pageHidden = false;
    if (event.persisted)
      bfcacheRestores = Math.min(bfcacheRestores + 1, 1_000_000);
    record("pageshow", event.persisted === true);
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  return {
    snapshot: () => ({
      observationAgeMs: elapsed(),
      initialVisibility,
      visibilityState: visibility(),
      readyState: document.readyState,
      observedHiddenDurationMs:
        hiddenDurationMs +
        (hiddenAt === undefined ? 0 : Math.max(0, elapsed() - hiddenAt)),
      visibilityChanges,
      bfcacheRestores,
      pageHidden,
      recentTransitions: recentTransitions.map((item) => ({ ...item })),
    }),
    close: () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    },
  };
};
