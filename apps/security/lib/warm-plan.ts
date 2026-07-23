import { Skia } from "@shopify/react-native-skia";
import { InteractionManager } from "react-native";
import { buildPlanPicture, PLAN_HEIGHT, PLAN_WIDTH } from "@emberly/ui";

/**
 * Pre-compile the property-map's Metal shaders behind the first screen.
 *
 * The plan picture is shader-diverse (blur mask-filter shadows, radial and
 * linear gradients, halo text, dashed strokes), and Skia's Metal backend
 * compiles a pipeline state per unique paint combination lazily at first
 * draw — on the thread doing the drawing. On a cold OS shader cache (first
 * launch after install/update) that's seconds of synchronous work, which is
 * exactly the "App Hang Fully Blocked · GrCompileMtlShaderLibrary" Sentry
 * event when it happens on the map tab's first frame.
 *
 * Drawing the same picture once into a tiny offscreen surface pays that cost
 * here instead: off the main thread (this runs on the JS thread), after the
 * launch screen has settled, before the guard ever opens the map. The
 * pipelines land in Skia's cache and the OS Metal cache, so the map's real
 * first frame reuses them. The day picture is warmed because its pipeline
 * set is a superset of night's (night skips the shadow blurs; colors don't
 * change pipelines).
 */

/** Tiny render target — pipeline compilation is resolution-independent. */
const WARM_SIZE = 64;

let warmed = false;

export function warmPlanShaders(): void {
  if (warmed) return;
  warmed = true;
  InteractionManager.runAfterInteractions(() => {
    // A beat after interactions settle, so hydration and the first data loads
    // aren't competing with the compile burst for the JS thread.
    setTimeout(() => {
      try {
        const surface = Skia.Surface.MakeOffscreen(WARM_SIZE, WARM_SIZE);
        if (!surface) return; // No GPU surface (e.g., some simulators) — nothing to warm.
        const canvas = surface.getCanvas();
        // Scale the whole page into the target so clip culling can't skip
        // any op — every draw must actually reach the GPU to compile.
        canvas.scale(WARM_SIZE / PLAN_WIDTH, WARM_SIZE / PLAN_HEIGHT);
        canvas.drawPicture(buildPlanPicture(false));
        surface.flush();
      } catch {
        // Warming is opportunistic — a failure just means the map's first
        // frame pays the compile cost, which is today's behavior.
      }
    }, 800);
  });
}
