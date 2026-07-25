import { Profiler, type ReactNode } from "react";

/**
 * Where a slow frame actually goes, measured on the device rather than guessed.
 *
 * Two rounds of optimizing this app from static reading produced real wins that
 * did not fix the complaint, and one confident hypothesis (that background tab
 * screens re-render on every switch) that turned out to be false — React
 * Navigation memoizes each scene on a stable navigation/route identity, so they
 * do not. Reading code cannot tell you what a phone spends 300ms on.
 *
 * React's own Profiler can. It reports every commit with the time React spent
 * rendering that subtree, in dev, on the real device with the real data. Anything
 * over one frame gets logged with the phase, so a tab switch prints exactly which
 * screen committed and how long it took.
 *
 * DEV ONLY — `__DEV__` compiles the whole thing out of a release bundle, and the
 * Profiler component itself is a passthrough when tracing is off.
 */

/** One 60fps frame. Anything slower than this is a dropped frame, so it prints. */
const FRAME_MS = 16;

let lastPress: { tab: string; at: number } | null = null;

/**
 * Mark the moment a tab was tapped, so the next commit can report the gap
 * between the tap and the screen actually appearing — the number the complaint
 * is about, which no single component's render time can tell you on its own.
 */
export function markTabPress(tab: string): void {
  if (!__DEV__) return;
  lastPress = { tab, at: Date.now() };
}

export function TraceRender({ id, children }: { id: string; children: ReactNode }) {
  if (!__DEV__) return <>{children}</>;
  return (
    <Profiler
      id={id}
      onRender={(profileId, phase, actualDuration) => {
        if (actualDuration < FRAME_MS) return;
        const pending = lastPress;
        const sinceTap = pending ? Date.now() - pending.at : null;
        // `mount` is a first visit (the screen had never been rendered);
        // `update` is a re-render of one already on screen. They call for
        // completely different fixes, so never collapse them into one number.
        const tail =
          sinceTap !== null && sinceTap < 3000
            ? ` — ${sinceTap}ms after tapping "${pending!.tab}"`
            : "";
        console.log(
          `[perf] ${profileId} ${phase} ${actualDuration.toFixed(0)}ms${tail}`,
        );
        if (sinceTap !== null && sinceTap < 3000) lastPress = null;
      }}
    >
      {children}
    </Profiler>
  );
}
