# Property map source

The designed property map, copied from the XCMS repo
(`XCMS/Kraken/Map/map3d/`) where it is generated. Do not edit these files by
hand — regenerate them there and re-copy.

- `mapdata.json` — geometry extracted 1:1 from the original ResMan `Map.pdf`
  (unit lattice cells, street-label phrases, road segments). The ground truth.
- `generate-overhead.mjs` — reads `mapdata.json` and draws the designed map.
  Writes `unitmap.svg`/`unitmap.html` plus `units.json`/`roads.json`. Kept here
  as provenance and so the map can be regenerated without digging up XCMS.
- `unitmap.svg` — the drawn map, 5347×3043. This is what the iOS app prints to
  `Map.pdf` and renders vector-crisp with CGPDF.
- `units.json` — per-unit rectangles **in the same 5347×3043 canvas space as
  the SVG**, exported by the same generator run. Because drawing and hit-rects
  come from one run, they cannot drift apart — the previous `map-data.json`
  was a stale export from an older map revision, which is exactly how the unit
  boxes ended up misaligned.
- `roads.json` — road segments with names, same two coordinate spaces.

`scripts/build-map-scene.mjs` compiles these into the runtime assets
(`assets/map-scene.json` + `assets/map-data.json`):

    bun run build:map

Skia cannot render PDFs or SVG text, so the SVG is parsed at build time into a
flat draw-op list the app replays into an SkPicture — same vector-at-every-zoom
approach as the Swift app, without the PDF.
