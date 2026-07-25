import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * A clock that holds still between ticks.
 *
 * `const nowMs = Date.now()` in a render body looks free and is not: it hands
 * every dependent `useMemo` a value that never repeats, so the memo recomputes
 * on every render and any `React.memo` below it compares unequal and re-renders
 * too. On the Work Orders screen that meant rebuilding the closed board's
 * sections — and re-rendering every mounted row — on renders that changed
 * nothing at all.
 *
 * A minute is the right granularity: everything reading this is day- or
 * day-difference-grained (timeline bands, ageing tints, days-to-close, move-in
 * recency). Anything needing a real second hand runs its own interval —
 * JobTimeCard does.
 *
 * Also re-reads on foreground, so a phone that sat in a pocket across midnight
 * shows the new day immediately rather than up to a minute late.
 */
export function useNowMs(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [intervalMs]);
  return now;
}
