import {
  BlurStyle,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  matchFont,
  type SkFont,
  type SkPaint,
  type SkPicture,
} from "@shopify/react-native-skia";
import scene from "../assets/map-scene.json";

/**
 * The property plan as a recorded Skia picture, built from the draw-op list
 * that scripts/build-map-scene.mjs compiles out of map-source/unitmap.svg.
 *
 * This is the RN equivalent of the Swift app's CGPDF rendering: the plan is
 * replayed as vectors under the live zoom transform every frame, so lines and
 * unit numbers stay sharp at any pinch level. A raster can't do that here —
 * readable text at max zoom would need a texture far past GPU limits.
 */

interface Gradient {
  kind: "radial" | "linear";
  cx?: string;
  cy?: string;
  r?: string;
  x1?: string;
  y1?: string;
  x2?: string;
  y2?: string;
  stops: { at: number; color: string }[];
}

interface Shadow {
  dx: number;
  dy: number;
  blur: number;
  color: string;
  opacity: number;
}

/** One SVG element, flattened. Optional keys are omitted at their defaults. */
interface Op {
  t: "r" | "c" | "p" | "x";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rx?: number;
  r?: number;
  d?: string;
  f?: string;
  g?: string;
  fo?: number;
  o?: number;
  s?: string;
  sw?: number;
  lc?: number;
  lj?: number;
  da?: number[];
  m?: number[];
  sh?: Shadow;
  // text
  str?: string;
  fs?: number;
  fw?: number;
  it?: number;
  ff?: string;
  mid?: number;
  end?: number;
  pr?: number;
  pcx?: number;
  pg?: number;
  cb?: number;
  ls?: number;
  hc?: string;
  hw?: number;
}

const SCENE = scene as unknown as {
  pageWidth: number;
  pageHeight: number;
  gradients: Record<string, Gradient>;
  ops: (Op & { s?: string })[];
};

export const PLAN_WIDTH = SCENE.pageWidth;
export const PLAN_HEIGHT = SCENE.pageHeight;

const pct = (v: string | undefined, fallback: number) =>
  v == null ? fallback : parseFloat(v) / 100;

/* ---------------- night palette ----------------
 * The plan is authored in daylight colors. Rather than a dimming veil (which
 * kills contrast), the night picture re-colors every op: key surfaces get
 * hand-picked night values, and everything else runs through an HSL rule —
 * light surfaces drop to dark ones, dark ink lifts to light, mids dim.
 */

const NIGHT_OVERRIDES: Record<string, string> = {
  // page gradient (grass ground)
  "#E3EACB": "#232A1B",
  "#D3DEB6": "#1B2114",
  // lawns
  "#DCE5C3": "#252D1D",
  // roads + edges
  "#F7F3E8": "#2A2D33",
  "#D9D2BF": "#41454D",
  // building cards
  "#FDFCF7": "#2B2F37",
  "#FFFEFA": "#2E323A",
  "#F4EFE1": "#272B32",
  "#CFC8B6": "#4C515B",
  "#E8E2D2": "#22262C",
  "#E5DFCE": "#3A3E46",
};

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Parse #rgb/#rrggbb/rgb()/rgba() to [r,g,b,a?] (0–255, alpha 0–1). */
function parseColor(c: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.replace(/./g, (ch) => ch + ch);
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(c.trim());
  if (fn) {
    const parts = fn[1].split(",").map((p) => parseFloat(p));
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }
  return null;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

const nightCache = new Map<string, string>();

function nightColor(c: string): string {
  const cached = nightCache.get(c);
  if (cached) return cached;
  const upper = c.trim().toUpperCase();
  let out: string | undefined = NIGHT_OVERRIDES[upper];
  if (!out) {
    const parsed = parseColor(c);
    if (!parsed) out = c;
    else {
      const [r, g, b, a] = parsed;
      const [h, s, l] = rgbToHsl(r, g, b);
      let l2: number;
      let s2 = s;
      if (l >= 0.72) {
        // Bright surface (halos, pills, pale fills) → dark surface.
        l2 = 0.17 + (l - 0.72) * 0.25;
        s2 = s * 0.5;
      } else if (l <= 0.45) {
        // Ink (unit numbers, street names, strokes) → light ink, keep hue.
        l2 = clamp01(0.82 - l * 0.25);
        s2 = s * 0.65;
      } else {
        // Mid tones (type accents, olive office, water) → dim slightly.
        l2 = l * 0.72;
      }
      const [r2, g2, b2] = hslToRgb(h, s2, clamp01(l2));
      out = a >= 1 ? `rgb(${r2},${g2},${b2})` : `rgba(${r2},${g2},${b2},${a})`;
    }
  }
  nightCache.set(c, out);
  return out;
}

/** SVG's default font stack for the map; iOS ships Avenir Next. */
const DEFAULT_FAMILY = "Avenir Next";

const fontCache = new Map<string, SkFont>();
function fontFor(op: Op): SkFont {
  const key = `${op.ff ?? ""}|${op.fs}|${op.fw ?? 400}|${op.it ?? 0}`;
  let font = fontCache.get(key);
  if (!font) {
    font = matchFont({
      fontFamily: op.ff ?? DEFAULT_FAMILY,
      fontSize: op.fs,
      fontStyle: op.it ? "italic" : "normal",
      fontWeight: String(op.fw ?? 400) as "400",
    });
    fontCache.set(key, font);
  }
  return font;
}

function textWidth(font: SkFont, s: string, ls: number): number {
  if (!ls) return font.getTextWidth(s);
  let w = 0;
  for (const ch of s) w += font.getTextWidth(ch) + ls;
  return w - ls;
}

/** drawText with SVG letter-spacing (per-glyph advance). */
function drawString(
  canvas: ReturnType<ReturnType<typeof Skia.PictureRecorder>["beginRecording"]>,
  s: string,
  x: number,
  y: number,
  paint: SkPaint,
  font: SkFont,
  ls: number,
) {
  if (!ls) {
    canvas.drawText(s, x, y, paint, font);
    return;
  }
  let cx = x;
  for (const ch of s) {
    canvas.drawText(ch, cx, y, paint, font);
    cx += font.getTextWidth(ch) + ls;
  }
}

function shaderFor(op: Op): ReturnType<typeof Skia.Shader.MakeRadialGradient> | null {
  const g = SCENE.gradients[op.g ?? ""];
  if (!g) return null;
  const colors = g.stops.map((s) => Skia.Color(resolve(s.color)));
  const pos = g.stops.map((s) => s.at);
  // Gradient units are the element's bounding box (SVG objectBoundingBox).
  const x = op.x ?? 0;
  const y = op.y ?? 0;
  const w = op.w ?? 0;
  const h = op.h ?? 0;
  if (g.kind === "radial") {
    const r = pct(g.r, 0.5) * Math.hypot(w, h) * Math.SQRT1_2;
    return Skia.Shader.MakeRadialGradient(
      { x: x + pct(g.cx, 0.5) * w, y: y + pct(g.cy, 0.5) * h },
      r,
      colors,
      pos,
      0,
    );
  }
  return Skia.Shader.MakeLinearGradient(
    { x: x + pct(g.x1, 0) * w, y: y + pct(g.y1, 0) * h },
    { x: x + pct(g.x2, 1) * w, y: y + pct(g.y2, 1) * h },
    colors,
    pos,
    0,
  );
}

/** Set once per build; every color a paint or shader sees flows through it. */
let NIGHT = false;
const resolve = (c: string) => (NIGHT ? nightColor(c) : c);

function alphaPaint(color: string, opacity: number): SkPaint {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(resolve(color)));
  if (opacity !== 1) p.setAlphaf(p.getAlphaf() * opacity);
  return p;
}

export function buildPlanPicture(night = false): SkPicture {
  NIGHT = night;
  const rec = Skia.PictureRecorder();
  const canvas = rec.beginRecording(Skia.XYWHRect(0, 0, PLAN_WIDTH, PLAN_HEIGHT));

  // Start-x handoff between the two halves of a centered label pair.
  let pairTailX: number | null = null;

  for (let opIndex = 0; opIndex < SCENE.ops.length; opIndex++) {
    const op = SCENE.ops[opIndex];
    const opacity = op.o ?? 1;
    const hasMatrix = !!op.m;
    if (hasMatrix) {
      const [a, b, c, d, e, f] = op.m as number[];
      canvas.save();
      canvas.concat(Skia.Matrix([a, c, e, b, d, f, 0, 0, 1]));
    }

    if (op.t === "x") {
      const font = fontFor(op);
      const s = op.str as string;
      const anchor = op.mid ? 0.5 : op.end ? 1 : 0;
      const w = anchor ? textWidth(font, s, op.ls ?? 0) : 0;
      let x = (op.x ?? 0) - w * anchor;
      if (op.pr === 1 && op.pcx != null) {
        // Lead half of a two-tone label pair: measure both halves with the
        // fonts we actually draw with and center the combined line on pcx —
        // the SVG's baked split assumed metrics this renderer may not share.
        const tail = SCENE.ops[opIndex + 1];
        const gap = op.pg ?? 5;
        const wLead = textWidth(font, s, op.ls ?? 0);
        const wTail =
          tail?.pr === 2 ? textWidth(fontFor(tail), (tail.str as string) ?? "", tail.ls ?? 0) : 0;
        x = op.pcx - (wLead + gap + wTail) / 2;
        pairTailX = x + wLead + gap;
      } else if (op.pr === 2 && pairTailX != null) {
        x = pairTailX;
        pairTailX = null;
      }
      let y = op.y ?? 0;
      if (op.cb) {
        // dominant-baseline="central": y names the glyph middle, not the baseline.
        const m = font.getMetrics();
        y += -(m.ascent + m.descent) / 2;
      }
      if (op.hc) {
        const halo = alphaPaint(op.hc, opacity);
        halo.setStyle(PaintStyle.Stroke);
        halo.setStrokeWidth(op.hw ?? 1);
        halo.setStrokeJoin(StrokeJoin.Round);
        drawString(canvas, s, x, y, halo, font, op.ls ?? 0);
      }
      drawString(canvas, s, x, y, alphaPaint(op.f ?? "#000", opacity), font, op.ls ?? 0);
      if (hasMatrix) canvas.restore();
      continue;
    }

    const drawShape = (paint: SkPaint, offsetX = 0, offsetY = 0) => {
      if (op.t === "r") {
        const rect = Skia.XYWHRect((op.x ?? 0) + offsetX, (op.y ?? 0) + offsetY, op.w ?? 0, op.h ?? 0);
        if (op.rx) canvas.drawRRect(Skia.RRectXY(rect, op.rx, op.rx), paint);
        else canvas.drawRect(rect, paint);
      } else if (op.t === "c") {
        canvas.drawCircle((op.x ?? 0) + offsetX, (op.y ?? 0) + offsetY, op.r ?? 0, paint);
      } else {
        const path = Skia.Path.MakeFromSVGString(op.d as string);
        if (!path) return;
        if (offsetX || offsetY) path.offset(offsetX, offsetY);
        canvas.drawPath(path, paint);
      }
    };

    // feDropShadow stand-in: the shape again, offset and blurred, underneath.
    // At night the ground is darker than the shadow — skip them.
    if (op.sh && !night) {
      const p = alphaPaint(op.sh.color, op.sh.opacity * opacity);
      p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, op.sh.blur, true));
      drawShape(p, op.sh.dx, op.sh.dy);
    }

    const hasFill = op.f != null || op.g != null;
    if (hasFill) {
      const p = alphaPaint(op.f ?? "#000", opacity * (op.fo ?? 1));
      const shader = op.g ? shaderFor(op) : null;
      if (shader) p.setShader(shader);
      drawShape(p);
    }
    if (op.s) {
      const p = alphaPaint(op.s, opacity);
      p.setStyle(PaintStyle.Stroke);
      p.setStrokeWidth(op.sw ?? 1);
      if (op.lc) p.setStrokeCap(StrokeCap.Round);
      if (op.lj) p.setStrokeJoin(StrokeJoin.Round);
      if (op.da) p.setPathEffect(Skia.PathEffect.MakeDash(op.da, 0));
      drawShape(p);
    }

    if (hasMatrix) canvas.restore();
  }

  return rec.finishRecordingAsPicture();
}
