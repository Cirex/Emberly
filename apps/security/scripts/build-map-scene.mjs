// Compiles map-source/ into the runtime map assets:
//
//   assets/map-scene.json — flat draw-op list parsed from unitmap.svg, replayed
//                           into an SkPicture at runtime (Skia renders neither
//                           PDFs nor SVG <text>, so the vector map is compiled
//                           to draw ops instead — same crisp-at-any-zoom result
//                           as the Swift app's CGPDF rendering)
//   assets/map-data.json  — unit + road rectangles normalized to the SVG page,
//                           taken from units.json/roads.json which the same
//                           generator run produced. Drawing and hit-rects share
//                           one source, so they cannot drift apart again.
//
// Run: bun run build:map
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "map-source");
const OUT = path.join(here, "..", "assets");
// map-scene.json is consumed by @emberly/ui's plan-picture.ts (the Skia map
// renderer was extracted into the shared package), so the generated scene must
// land there, not in this app's now-unused assets dir. map-data.json below still
// belongs to the apps and stays in OUT.
const SCENE_OUT = path.join(here, "..", "..", "..", "packages", "ui", "src", "assets");

const svg = fs.readFileSync(path.join(SRC, "unitmap.svg"), "utf8");

/* ---------------- defs: drop-shadow filters + gradients ---------------- */

const shadows = {};
for (const m of svg.matchAll(
  /<filter id="([^"]+)"[^>]*>\s*<feDropShadow dx="([^"]+)" dy="([^"]+)" stdDeviation="([^"]+)" flood-color="([^"]+)" flood-opacity="([^"]+)"/g,
)) {
  shadows[m[1]] = { dx: +m[2], dy: +m[3], blur: +m[4], color: m[5], opacity: +m[6] };
}

const gradients = {};
for (const m of svg.matchAll(/<(radialGradient|linearGradient) id="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g)) {
  const stops = [...m[4].matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"/g)].map((s) => ({
    at: parseFloat(s[1]) / 100,
    color: s[2],
  }));
  const attrs = Object.fromEntries([...m[3].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
  gradients[m[2]] = { kind: m[1] === "radialGradient" ? "radial" : "linear", ...attrs, stops };
}

/* ---------------- transforms ---------------- */

const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const isIdentity = (m) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);

function parseTransform(str) {
  let m = IDENTITY;
  if (!str) return m;
  for (const t of str.matchAll(/(translate|rotate|scale)\(([^)]*)\)/g)) {
    const n = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (t[1] === "translate") m = mul(m, [1, 0, 0, 1, n[0], n[1] ?? 0]);
    else if (t[1] === "scale") m = mul(m, [n[0], 0, 0, n[1] ?? n[0], 0, 0]);
    else {
      const a = (n[0] * Math.PI) / 180;
      const r = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
      if (n.length === 3) m = mul(m, mul([1, 0, 0, 1, n[1], n[2]], mul(r, [1, 0, 0, 1, -n[1], -n[2]])));
      else m = mul(m, r);
    }
  }
  return m;
}

/* ---------------- element walk ---------------- */

const rnd = (v) => Math.round(v * 100) / 100;
const decode = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

function attrsOf(s) {
  return Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
}

// Fill/stroke annotate: undefined attr on a drawable means SVG's default black.
function paint(op, a) {
  const fill = a.fill ?? "#000";
  if (fill !== "none") {
    const grad = /^url\(#(.+)\)$/.exec(fill);
    if (grad) op.g = grad[1];
    else op.f = fill;
    if (a["fill-opacity"] != null) op.fo = +a["fill-opacity"];
  }
  if (a.stroke && a.stroke !== "none") {
    op.s = a.stroke;
    op.sw = a["stroke-width"] != null ? +a["stroke-width"] : 1;
    if (a["stroke-linecap"] === "round") op.lc = 1;
    if (a["stroke-linejoin"] === "round") op.lj = 1;
    if (a["stroke-dasharray"]) op.da = a["stroke-dasharray"].split(/[\s,]+/).map(Number);
  }
  if (a.opacity != null) op.o = +a.opacity;
  return op;
}

// Body between </defs> and </svg>: walk tags in document order with a group stack.
const body = svg.slice(svg.indexOf("</defs>") + 7, svg.lastIndexOf("</svg>"));
const tagRe = /<g\b([^>]*)>|<\/g>|<(rect|circle|polygon|path)\b([^>]*?)\/?>|<text\b([^>]*)>([\s\S]*?)<\/text>/g;

const ops = [];
const stack = [{ m: IDENTITY, o: 1, sh: null }];
let match;
while ((match = tagRe.exec(body))) {
  const top = stack[stack.length - 1];
  if (match[0] === "</g>") {
    stack.pop();
    continue;
  }
  if (match[0].startsWith("<g")) {
    const a = attrsOf(match[1]);
    const filter = /url\(#(.+)\)/.exec(a.filter ?? "");
    stack.push({
      m: mul(top.m, parseTransform(a.transform)),
      o: top.o * (a.opacity != null ? +a.opacity : 1),
      sh: filter ? (shadows[filter[1]] ?? top.sh) : top.sh,
    });
    continue;
  }

  const isText = match[0].startsWith("<text");
  const a = attrsOf(isText ? match[4] : match[3]);
  const m = mul(top.m, parseTransform(a.transform));
  let op;

  if (isText) {
    const text = decode(match[5]).replace(/\s+/g, " ").trim();
    if (!text) continue;
    op = { t: "x", x: rnd(+(a.x ?? 0)), y: rnd(+(a.y ?? 0)), str: text, fs: +(a["font-size"] ?? 16) };
    op.f = a.fill ?? "#000";
    if (a.opacity != null) op.o = +a.opacity;
    if (a["font-weight"]) op.fw = +a["font-weight"];
    if (a["font-style"] === "italic") op.it = 1;
    if (a["font-family"]) op.ff = a["font-family"].split(",")[0].trim();
    if (a["text-anchor"] === "middle") op.mid = 1;
    if (a["text-anchor"] === "end") op.end = 1;
    // Two-part label pair: the renderer centers lead+tail as one line on pcx,
    // measuring with its own fonts (SVG viewers just use the baked x's).
    if (a["data-pair"]) op.pr = a["data-pair"] === "lead" ? 1 : 2;
    if (a["data-pair-cx"] != null) op.pcx = +a["data-pair-cx"];
    if (a["data-pair-gap"] != null) op.pg = +a["data-pair-gap"];
    if (a["dominant-baseline"] === "central") op.cb = 1;
    if (a["letter-spacing"]) op.ls = +a["letter-spacing"];
    // paint-order="stroke": the stroke is a halo drawn behind the fill.
    if (a["paint-order"] === "stroke" && a.stroke && a.stroke !== "none") {
      op.hc = a.stroke;
      op.hw = a["stroke-width"] != null ? +a["stroke-width"] : 1;
    }
  } else if (match[2] === "rect") {
    op = paint({ t: "r", x: rnd(+(a.x ?? 0)), y: rnd(+(a.y ?? 0)), w: rnd(+a.width), h: rnd(+a.height) }, a);
    if (a.rx) op.rx = +a.rx;
  } else if (match[2] === "circle") {
    op = paint({ t: "c", x: rnd(+a.cx), y: rnd(+a.cy), r: rnd(+a.r) }, a);
  } else if (match[2] === "polygon") {
    const pts = a.points.trim().split(/[\s,]+/).map(Number);
    let d = `M ${pts[0]} ${pts[1]}`;
    for (let i = 2; i < pts.length; i += 2) d += ` L ${pts[i]} ${pts[i + 1]}`;
    op = paint({ t: "p", d: d + " Z" }, a);
  } else {
    op = paint({ t: "p", d: a.d }, a);
  }

  if (top.o !== 1) op.o = (op.o ?? 1) * top.o;
  if (!isIdentity(m)) op.m = m.map(rnd);
  // The SVG applies feDropShadow to whole groups; per-op it only makes sense
  // under the shapes (a shadow behind every glyph would read as smudge).
  if (top.sh && !isText) op.sh = top.sh;
  ops.push(op);
}

/* ---------------- page + write scene ---------------- */

const [, W, H] = /<svg[^>]*width="(\d+)" height="(\d+)"/.exec(svg).map(Number);
const scene = { pageWidth: W, pageHeight: H, gradients, ops };
fs.writeFileSync(path.join(SCENE_OUT, "map-scene.json"), JSON.stringify(scene));

/* ---------------- units + roads (normalized to the same page) ---------------- */

const unitsSrc = JSON.parse(fs.readFileSync(path.join(SRC, "units.json"), "utf8"));
const units = {};
for (const u of unitsSrc.units) {
  units[`${u.building} ${u.street}-${u.unit}`] = {
    x: +(u.px.x0 / W).toFixed(6),
    y: +(u.px.y0 / H).toFixed(6),
    w: +((u.px.x1 - u.px.x0) / W).toFixed(6),
    h: +((u.px.y1 - u.px.y0) / H).toFixed(6),
  };
}

const roadsSrc = JSON.parse(fs.readFileSync(path.join(SRC, "roads.json"), "utf8"));
const roads = roadsSrc.roads.map((r) => ({
  name: r.name,
  orientation: r.orientation,
  x: +(r.px.x0 / W).toFixed(6),
  y: +(r.px.y0 / H).toFixed(6),
  w: +((r.px.x1 - r.px.x0) / W).toFixed(6),
  h: +((r.px.y1 - r.px.y0) / H).toFixed(6),
}));

// Building blocks — the rounded cards the generator draws (one per
// building+street group, inset 1.5px with rx 5). Unit tint overlays clip to
// these so highlights follow the card's rounded corners instead of poking out.
const blockMap = new Map();
for (const u of unitsSrc.units) {
  const key = `${u.building} ${u.street}`;
  const b = blockMap.get(key) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, units: [] };
  b.x0 = Math.min(b.x0, u.px.x0);
  b.y0 = Math.min(b.y0, u.px.y0);
  b.x1 = Math.max(b.x1, u.px.x1);
  b.y1 = Math.max(b.y1, u.px.y1);
  b.units.push(`${u.building} ${u.street}-${u.unit}`);
  blockMap.set(key, b);
}
const blocks = [...blockMap.values()].map((b) => ({
  x: +((b.x0 + 1.5) / W).toFixed(6),
  y: +((b.y0 + 1.5) / H).toFixed(6),
  w: +((b.x1 - b.x0 - 3) / W).toFixed(6),
  h: +((b.y1 - b.y0 - 3) / H).toFixed(6),
  units: b.units,
}));

fs.writeFileSync(
  path.join(OUT, "map-data.json"),
  JSON.stringify({ pageWidth: W, pageHeight: H, units, roads, blocks }, null, 1),
);

/* ---------------- report ---------------- */

const byType = {};
for (const op of ops) byType[op.t] = (byType[op.t] ?? 0) + 1;
console.log(`map-scene.json: ${ops.length} ops`, byType, `page ${W}x${H}`);
console.log(`shadowed shapes: ${ops.filter((o) => o.sh).length}`);
console.log(`map-data.json: ${Object.keys(units).length} units, ${roads.length} roads`);
