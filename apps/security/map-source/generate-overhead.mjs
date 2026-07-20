// Emberly Apartments (formerly New Horizon) — overhead 3D property & unit map
// Geometry extracted 1:1 from Map.pdf (mapdata.json) — every unit cell is
// exactly where Map.pdf places it. Orientation matches Map.pdf (north = right).
// Run: node generate-overhead.mjs  → writes unitmap.svg + unitmap.html
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'mapdata.json'), 'utf8'));

/* ---------------- transform (pdf pt → canvas px) ---------------- */
const SC = 4.6;
const X0 = 36, Y0 = 152;                 // pdf-space crop origin
const MX = 70, MY = 70;                  // canvas margins (header band removed)
const tx = x => (x - X0) * SC + MX;
const ty = y => (y - Y0) * SC + MY;
const W = Math.round(tx(1168) + 70);
const H = Math.round(ty(756) + 55);   // extra band at the bottom for the Days Creek greenway

/* ---------------- palette (app-mockup inspired) ---------------- */
const C = {
  page: '#F0EBDF', lawn: '#DCE5C3', lawn2: '#D3DEB6',
  road: '#F7F3E8', roadEdge: '#D9D2BF',
  bld: '#FDFCF7', bldEdge: '#CFC8B6', bldShade: '#E8E2D2', divider: '#E5DfCE',
  num: '#33406A', navy: '#1E2B5E',
  types: { b1: '#C98A2B', b2: '#C25E42', b34: '#3E7F73' },
  typeNames: { b1: 'One Bedroom', b2: 'Two Bedroom', b34: 'Three & Four Bedroom' },
  olive: '#8F9433', oliveDark: '#767B24',
  water: '#8FC3DC', waterEdge: '#6FA9C6',
  treeDark: '#66883F', tree: ['#7FA353', '#8CB061', '#97BC6C', '#749A49'],
  trunkShadow: 'rgba(70,84,48,.25)',
  dim: '#8A8471', accent: '#C3493E',
};
const CODE_TYPE = {
  CC:'b1', DU:'b1', EG:'b1',
  MBR:'b2', DE:'b2', DV:'b2', LB:'b2', CL:'b2', MBP:'b2', CW:'b2', LP:'b2', ST:'b2', MBS:'b2',
  KG:'b34', PJ:'b34', QL:'b34', QU:'b34', WD:'b34', SNG:'b34', NG:'b34', VI:'b34', BA:'b34', WX:'b34', BW:'b34', CH:'b34',
};

/* ---------------- unit cells → building blocks ---------------- */
const CW = 20.72, CH = 7.4;              // lattice pitch measured from Map.pdf
const units = data.units.map(u => ({ ...u, type: CODE_TYPE[u.code] || 'b34' }));

// connected components within each (bld, code) group
const groups = {};
for (const u of units) (groups[u.bld + ' ' + u.code] ||= []).push(u);
const blocks = [];
for (const key of Object.keys(groups)) {
  const g = groups[key];
  const parent = g.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < g.length; i++)
    for (let j = i + 1; j < g.length; j++) {
      const dx = Math.abs(g[i].cx - g[j].cx), dy = Math.abs(g[i].cy - g[j].cy);
      if ((dx < CW * 1.15 && dy < CH * 0.6) || (dy < CH * 1.15 && dx < CW * 0.6)) parent[find(i)] = find(j);
    }
  const comp = {};
  g.forEach((u, i) => (comp[find(i)] ||= []).push(u));
  for (const cells of Object.values(comp)) {
    const x0 = Math.min(...cells.map(u => u.cx)) - CW / 2, x1 = Math.max(...cells.map(u => u.cx)) + CW / 2;
    const y0 = Math.min(...cells.map(u => u.cy)) - CH / 2, y1 = Math.max(...cells.map(u => u.cy)) + CH / 2;
    blocks.push({ key, bld: cells[0].bld, code: cells[0].code, type: cells[0].type, cells, x0, y0, x1, y1 });
  }
}
console.log('blocks:', blocks.length, ' units:', units.length);

/* ---------------- streets from paired parallel lines ---------------- */
const roadRects = [];
{
  const usedH = new Set(), usedV = new Set();
  const Hs = data.H.filter(l => l[1] - l[0] > 30);
  const Vs = data.V.filter(l => l[1] - l[0] > 25);
  // exclude lines that are building block edges
  const isBlockEdgeH = l => blocks.some(b => (Math.abs(l[2] - b.y0) < 1.2 || Math.abs(l[2] - b.y1) < 1.2) && l[0] > b.x0 - 2 && l[1] < b.x1 + 2);
  const isBlockEdgeV = l => blocks.some(b => (Math.abs(l[2] - b.x0) < 1.2 || Math.abs(l[2] - b.x1) < 1.2) && l[0] > b.y0 - 2 && l[1] < b.y1 + 2);
  const H2 = Hs.filter(l => !isBlockEdgeH(l)), V2 = Vs.filter(l => !isBlockEdgeV(l));
  for (let i = 0; i < H2.length; i++) for (let j = i + 1; j < H2.length; j++) {
    const a = H2[i], b = H2[j];
    if (usedH.has(i) || usedH.has(j)) continue;
    if (Math.abs(a[0] - b[0]) < 6 && Math.abs(a[1] - b[1]) < 6 && Math.abs(a[2] - b[2]) > 5 && Math.abs(a[2] - b[2]) < 11) {
      roadRects.push({ x0: Math.min(a[0], b[0]), x1: Math.max(a[1], b[1]), y0: Math.min(a[2], b[2]), y1: Math.max(a[2], b[2]) });
      usedH.add(i); usedH.add(j);
    }
  }
  for (let i = 0; i < V2.length; i++) for (let j = i + 1; j < V2.length; j++) {
    const a = V2[i], b = V2[j];
    if (usedV.has(i) || usedV.has(j)) continue;
    if (Math.abs(a[0] - b[0]) < 6 && Math.abs(a[1] - b[1]) < 6 && Math.abs(a[2] - b[2]) > 5 && Math.abs(a[2] - b[2]) < 11) {
      roadRects.push({ x0: Math.min(a[2], b[2]), x1: Math.max(a[2], b[2]), y0: Math.min(a[0], b[0]), y1: Math.max(a[1], b[1]) });
      usedV.add(i); usedV.add(j);
    }
  }
}
console.log('road segments (paired):', roadRects.length);

/* ---------------- street label list (cleaned from Map.pdf phrases) ---------------- */
const streetLabels = [
  ['MILLBRANCH ROAD', 800, 143, 0], ['MILLBRANCH ROAD', 1010, 143, 0],
  ['DEVON DRIVE', 782.6, 169, 0], ['DEVON DRIVE', 1020.2, 169, 0],
  ['COMMONWEALTH DRIVE', 917, 195, 90], ['COMMONWEALTH DRIVE', 917, 297, 90],
  ['LIVERPOOL DRIVE', 1154, 200, 90], ['LIVERPOOL DRIVE', 1154, 297, 90],
  ['LONG BOW DRIVE', 538.8, 221, 0], ['LONG BOW DRIVE', 776.7, 221, 0], ['LONG BOW DRIVE', 1015, 221, 0],
  ['SOUTH MILLBRANCH DRIVE', 440, 272, 90], ['SINGING TREES DRIVE', 678, 272, 90],
  ['CLAYMORE DRIVE', 537.3, 272.5, 0], ['CLAYMORE DRIVE', 775.6, 272.5, 0], ['CLAYMORE DRIVE', 1013.9, 272.5, 0],
  ['MILLBRANCH PARK DRIVE', 531.4, 324, 0], ['MILLBRANCH PARK DRIVE', 768.9, 324, 0], ['MILLBRANCH PARK DRIVE', 1007.6, 324, 0],
  ['KINGSGATE DRIVE', 778.2, 350.5, 0], ['KINGSGATE DRIVE', 945.4, 350.5, 0],
  ['KINGSGATE DRIVE', 720, 398, 90], ['KINGSGATE DRIVE', 720, 445, 90], ['KINGSGATE DRIVE', 720, 495, 90],
  ['NEW GATE DRIVE', 999, 396, 90], ['NEW GATE DRIVE', 999, 444, 90], ['NEW GATE DRIVE', 999, 490, 90],
  ['POPINJAY DRIVE', 842.9, 398.5, 0],
  ['QUEENSLAND DRIVE', 206.5, 428, 0], ['QUEENSLAND DRIVE', 378.6, 446.5, 0], ['QUEENSLAND DRIVE', 486.6, 446.5, 0],
  ['QUEENSLAND DRIVE', 619.8, 446.5, 0], ['QUEENSLAND DRIVE', 840, 447, 0],
  ['QUILL DRIVE', 215.4, 472.5, 0], ['VICTORIA DRIVE', 347, 487, 90], ['BARONESS DRIVE', 456, 488, 90],
  ['WESSEX DRIVE', 565, 487, 90], ['WOODSFIELD DRIVE', 839.2, 494.7, 0],
  ['CHESSWAY DRIVE', 209.5, 517.3, 0],
  ['KINGSGATE DRIVE', 383, 535.4, 0], ['KINGSGATE DRIVE', 492.2, 535.4, 0], ['KINGSGATE DRIVE', 622.4, 535.4, 0],
  ['NEW GATE DRIVE SOUTH', 869.9, 542.8, 0], ['KINGSGATE DRIVE', 209.5, 546.5, 0],
  ['BERWIND DRIVE', 67, 472, 90], ['BERWIND ROAD', 46.5, 572, 90], ['BERWIND ROAD', 46.5, 637, 90],
  ['VICTORIA ROAD', 404, 598, 90],
  ['CAZASSA DRIVE', 122.5, 594.6, 0], ['CAZASSA DRIVE', 295.3, 594.6, 0], ['CAZASSA DRIVE', 501.4, 594.6, 0],
  ['DUCHESS DRIVE', 121.8, 617.2, 0], ['DUCHESS DRIVE', 501.1, 616.8, 0],
  ['EGLESFIELD DRIVE', 121.8, 661.2, 0], ['EGLESFIELD DRIVE', 247.7, 660.8, 0], ['EGLESFIELD DRIVE', 379.3, 661.2, 0],
];

/* guarantee a road under every street label (fills unpaired stretches) */
for (const [name, x, y, rot] of streetLabels) {
  if (name === 'MILLBRANCH ROAD') continue;   // public road beyond the boundary — label only
  const half = name.length * 3.1 + 42;
  if (!rot) {
    const cy = y + 3;
    if (!roadRects.some(r => Math.abs((r.y0 + r.y1) / 2 - cy) < 6 && x > r.x0 && x < r.x1 && r.x1 - r.x0 > r.y1 - r.y0))
      roadRects.push({ x0: x - half, x1: x + half, y0: cy - 3.7, y1: cy + 3.7 });
  } else {
    const cx = x - 3;
    if (!roadRects.some(r => Math.abs((r.x0 + r.x1) / 2 - cx) < 6 && y > r.y0 && y < r.y1 && r.y1 - r.y0 > r.x1 - r.x0))
      roadRects.push({ x0: cx - 3.7, x1: cx + 3.7, y0: y - half, y1: y + half });
  }
}
/* keep only real streets: strips validated by a street label, plus unlabeled
   connectors that join two validated streets (Map.pdf also outlines building
   clusters with boxes — the thin slivers those create are NOT roads) */
{
  const isHs = r => (r.x1 - r.x0) >= (r.y1 - r.y0);
  const nearLabel = r => streetLabels.some(([, lx, ly, rot]) => {
    if (isHs(r) && !rot) return Math.abs((r.y0 + r.y1) / 2 - (ly + 3)) < 10 && lx > r.x0 - 12 && lx < r.x1 + 12;
    if (!isHs(r) && rot) return Math.abs((r.x0 + r.x1) / 2 - (lx - 3)) < 10 && ly > r.y0 - 12 && ly < r.y1 + 12;
    return false;
  });
  const touch = (a, b) => a.x0 < b.x1 + 2.5 && b.x0 < a.x1 + 2.5 && a.y0 < b.y1 + 2.5 && b.y0 < a.y1 + 2.5;
  const ok = roadRects.map(nearLabel);
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    roadRects.forEach((r, i) => {
      if (ok[i]) return;
      let n = 0;
      roadRects.forEach((s, j) => { if (i !== j && ok[j] && touch(r, s)) n++; });
      if (n >= 2 || (n >= 1 && Math.max(r.x1 - r.x0, r.y1 - r.y0) < 60)) { ok[i] = true; changed = true; }
    });
    if (!changed) break;
  }
  const dropped = roadRects.length;
  for (let i = roadRects.length - 1; i >= 0; i--) if (!ok[i]) roadRects.splice(i, 1);
  console.log('dropped sliver strips:', dropped - roadRects.length);
}

/* heal the network: bridge collinear gaps, extend ends to cross streets —
   never through a building */
const roadBlockHit = (x0, y0, x1, y1, m = 2.8) => blocks.some(b => x0 < b.x1 - m && x1 > b.x0 + m && y0 < b.y1 - m && y1 > b.y0 + m);
{
  const isH = r => (r.x1 - r.x0) >= (r.y1 - r.y0);
  for (let pass = 0; pass < 4; pass++) {
    // merge collinear segments; bridge gaps up to 70pt when the corridor is clear
    for (let i = roadRects.length - 1; i >= 0; i--) for (let j = i - 1; j >= 0; j--) {
      const a = roadRects[i], b = roadRects[j];
      if (!a || !b || isH(a) !== isH(b)) continue;
      if (isH(a)) {
        if (Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) < 4 && a.x0 < b.x1 + 70 && b.x0 < a.x1 + 70) {
          const gx0 = Math.min(a.x1, b.x1), gx1 = Math.max(a.x0, b.x0);
          if (gx1 > gx0 && roadBlockHit(gx0, b.y0, gx1, b.y1)) continue;
          b.x0 = Math.min(a.x0, b.x0); b.x1 = Math.max(a.x1, b.x1);   // survivor keeps its own perp band
          roadRects.splice(i, 1); break;
        }
      } else {
        if (Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) < 4 && a.y0 < b.y1 + 70 && b.y0 < a.y1 + 70) {
          const gy0 = Math.min(a.y1, b.y1), gy1 = Math.max(a.y0, b.y0);
          if (gy1 > gy0 && roadBlockHit(b.x0, gy0, b.x1, gy1)) continue;
          b.y0 = Math.min(a.y0, b.y0); b.y1 = Math.max(a.y1, b.y1);
          roadRects.splice(i, 1); break;
        }
      }
    }
    // extend each end to the nearest crossing street within reach (block-checked)
    for (const a of roadRects) for (const b of roadRects) {
      if (a === b || isH(a) === isH(b)) continue;
      const h = isH(a) ? a : b, v = isH(a) ? b : a;
      const cy = (h.y0 + h.y1) / 2;
      if (cy > v.y0 - 9 && cy < v.y1 + 9) {
        if (v.x0 > h.x1 - 2 && v.x0 < h.x1 + 80 && !roadBlockHit(h.x1, h.y0, v.x0 + 1, h.y1)) h.x1 = v.x1;
        if (v.x1 < h.x0 + 2 && v.x1 > h.x0 - 80 && !roadBlockHit(v.x1 - 1, h.y0, h.x0, h.y1)) h.x0 = v.x0;
      }
      const cx = (v.x0 + v.x1) / 2;
      if (cx > h.x0 - 9 && cx < h.x1 + 9) {
        if (h.y0 > v.y1 - 2 && h.y0 < v.y1 + 80 && !roadBlockHit(v.x0, v.y1, v.x1, h.y0 + 1)) v.y1 = h.y1;
        if (h.y1 < v.y0 + 2 && h.y1 > v.y0 - 80 && !roadBlockHit(v.x0, h.y1 - 1, v.x1, v.y0)) v.y0 = h.y0;
      }
    }
  }
}

/* never run a road through a building: trim overlapping stretches back */
{
  const isH = r => (r.x1 - r.x0) >= (r.y1 - r.y0);
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const r of roadRects) for (const b of blocks) {
      // only a true pass-through counts (>3pt of perpendicular overlap); grazes hide under the building
      const px = Math.min(r.x1, b.x1) - Math.max(r.x0, b.x0);
      const py = Math.min(r.y1, b.y1) - Math.max(r.y0, b.y0);
      if (px < 3 || py < 3) continue;
      if (isH(r)) {
        const lossEast = r.x1 - (b.x0 - 2), lossWest = (b.x1 + 2) - r.x0;
        if (lossEast <= lossWest) r.x1 = Math.max(r.x0 + 4, b.x0 - 2);
        else r.x0 = Math.min(r.x1 - 4, b.x1 + 2);
      } else {
        const lossS = r.y1 - (b.y0 - 2), lossN = (b.y1 + 2) - r.y0;
        if (lossS <= lossN) r.y1 = Math.max(r.y0 + 4, b.y0 - 2);
        else r.y0 = Math.min(r.y1 - 4, b.y1 + 2);
      }
      changed = true;
    }
    if (!changed) break;
  }
}
/* connect orphan segments to the main network (real streets all connect —
   Google Maps confirms Berwind/Victoria/Devon/Kingsgate etc. are through-roads) */
{
  const touch = (a, b) => a.x0 < b.x1 + 2 && b.x0 < a.x1 + 2 && a.y0 < b.y1 + 2 && b.y0 < a.y1 + 2;
  const blockHit = (x0, y0, x1, y1) => blocks.some(b => x0 < b.x1 - 1 && x1 > b.x0 + 1 && y0 < b.y1 - 1 && y1 > b.y0 + 1);
  const isH = r => (r.x1 - r.x0) >= (r.y1 - r.y0);
  for (let pass = 0; pass < 4; pass++) {
    const par = roadRects.map((_, i) => i);
    const find = i => par[i] === i ? i : (par[i] = find(par[i]));
    for (let i = 0; i < roadRects.length; i++) for (let j = i + 1; j < roadRects.length; j++)
      if (touch(roadRects[i], roadRects[j])) par[find(i)] = find(j);
    const sizes = {};
    roadRects.forEach((_, i) => sizes[find(i)] = (sizes[find(i)] || 0) + 1);
    const main = +Object.keys(sizes).reduce((a, b) => sizes[a] >= sizes[b] ? a : b);
    let healed = 0;
    roadRects.forEach((r, i) => {
      if (find(i) === main) return;
      const others = roadRects.filter((_, j) => find(j) !== find(i));
      let best = null;
      if (isH(r)) {
        for (const v of others) {
          if (!(r.y0 < v.y1 + 8 && r.y1 > v.y0 - 8)) continue;
          if (v.x1 <= r.x0 + 2) { const d = r.x0 - v.x1; if (d < 48 && (!best || d < best.d) && !blockHit(v.x1 - 1, r.y0, r.x0, r.y1)) best = { d, do: () => r.x0 = v.x0 + 1 }; }
          if (v.x0 >= r.x1 - 2) { const d = v.x0 - r.x1; if (d < 48 && (!best || d < best.d) && !blockHit(r.x1, r.y0, v.x0 + 1, r.y1)) best = { d, do: () => r.x1 = v.x1 - 1 }; }
        }
      } else {
        for (const h of others) {
          if (!(r.x0 < h.x1 + 8 && r.x1 > h.x0 - 8)) continue;
          if (h.y1 <= r.y0 + 2) { const d = r.y0 - h.y1; if (d < 48 && (!best || d < best.d) && !blockHit(r.x0, h.y1 - 1, r.x1, r.y0)) best = { d, do: () => r.y0 = h.y0 + 1 }; }
          if (h.y0 >= r.y1 - 2) { const d = h.y0 - r.y1; if (d < 48 && (!best || d < best.d) && !blockHit(r.x0, r.y1, r.x1, h.y0 + 1)) best = { d, do: () => r.y1 = h.y1 - 1 }; }
        }
      }
      if (best) { best.do(); healed++; }
    });
    if (!healed) break;
  }
  // drop anything still disconnected (spurious slivers), then report
  {
    const par = roadRects.map((_, i) => i);
    const find = i => par[i] === i ? i : (par[i] = find(par[i]));
    for (let i = 0; i < roadRects.length; i++) for (let j = i + 1; j < roadRects.length; j++)
      if (touch(roadRects[i], roadRects[j])) par[find(i)] = find(j);
    const sizes = {};
    roadRects.forEach((_, i) => sizes[find(i)] = (sizes[find(i)] || 0) + 1);
    const main = +Object.keys(sizes).reduce((a, b) => sizes[a] >= sizes[b] ? a : b);
    for (let i = roadRects.length - 1; i >= 0; i--) if (find(i) !== main) {
      const r = roadRects[i];
      console.log('  dropped orphan road:', r.x0.toFixed(0), r.y0.toFixed(0), '-', r.x1.toFixed(0), r.y1.toFixed(0));
      roadRects.splice(i, 1);
    }
    console.log('road components after healing: 1 (dropped orphans:', Object.keys(sizes).length - 1, ')');
  }
}
/* ground-truth corrections:
   - Kingsgate by the office is ONE road (kill the duplicate strip), connects to
     Millbranch Park Dr and ends at New Gate Dr S with a hard 90-degree turn
   - Kingsgate (south) jogs at Victoria Dr instead of running as two parallels
   - Cazassa continues east to the property gate; Duchess turns up into Cazassa */
{
  const near = (v, t, tol = 6) => Math.abs(v - t) < tol;
  for (let i = roadRects.length - 1; i >= 0; i--) {
    const r = roadRects[i];
    if (near(r.x0, 725, 2.5) && near(r.x1, 730.2, 2.5) && (r.y1 - r.y0) > 100) { roadRects.splice(i, 1); continue; }
    if (near(r.x0, 713.3, 4) && (r.y1 - r.y0) > 100) { r.x0 = 712; r.x1 = 726; r.y0 = 322; r.y1 = 549.5; }
    if (near(r.y0, 545.8, 3) && r.x0 < 100 && (r.x1 - r.x0) > 200) r.x1 = 346;
    if (near(r.y0, 591.1, 3) && r.x1 > 400) r.x1 = 676;
  }
  // road west of 3693 connecting Chessway down to Kingsgate
  roadRects.push({ x0: 280.9, y0: 519, x1: 288.3, y1: 551 });
  // Duchess runs a little past the 3644 building, then turns up into Cazassa
  for (const r of roadRects) if (near(r.y0, 616.1, 2) && r.x0 > 300 && r.x1 > 500) r.x1 = 628.5;
  roadRects.push({ x0: 621.1, y0: 597, x1: 628.5, y1: 617.5 });
  // Eglesfield runs all the way to the east end of the 3661 building
  for (const r of roadRects) if (near(r.y0, 660.5, 2) && r.x1 > 400) r.x1 = 498;
  // Duchess loops back down to Eglesfield (both the S and N Duchess loops)
  for (const r of roadRects) if (near(r.y0, 616.5, 3) && r.x0 < 100 && r.x1 > 180) r.x1 = 231.4;
  roadRects.push({ x0: 224, y0: 618, x1: 231.4, y1: 663 });       // S Duchess loop return
  // N Duchess loop return is Victoria Road itself — normalize it: standard width,
  // ends flush at Eglesfield (Map.pdf shows nothing continuing south of it).
  // North of Kingsgate there is NO road — the 1808/1809 gap is green space
  for (const r of roadRects) if (near(r.x0, 398.7, 2) && r.y1 > 670) { r.x1 = 406.1; r.y0 = 545.8; r.y1 = 667.9; }
  // office-area cleanups:
  for (let i = roadRects.length - 1; i >= 0; i--) {
    const r = roadRects[i];
    // spurious stubs beside the office / between 3616 and 3624
    if (r.x0 > 705 && r.x1 < 735 && (r.y1 - r.y0) < 12 && (r.x1 - r.x0) < 25) roadRects.splice(i, 1);
  }
  for (const r of roadRects) {
    // Kingsgate by the office: normal width, starts at the Kingsgate Dr corner
    // (it does NOT connect to Millbranch Park), clean 90° corner at the south end
    if (near(r.x0, 712, 3) && (r.y1 - r.y0) > 100) { r.x0 = 714.2; r.x1 = 722.8; r.y0 = 349.8; r.y1 = 553.2; }
    // Singing Trees ends flush at Millbranch Park
    if (near(r.x0, 673.2, 3) && (r.y1 - r.y0) > 100) r.y1 = 329;
    // New Gate Dr S does not junction with Kingsgate — Kingsgate continues west
    if (near(r.y0, 542.1, 3) && near(r.x1, 999.7, 5)) r.x0 = 777;
    // Kingsgate runs STRAIGHT through here (no jog at Victoria): drop the east
    // segment onto the west segment's line, corner flush at the office vertical
    if (near(r.y0, 534.7, 3) && near(r.x1, 730.2, 3) && (r.x1 - r.x0) > 200) { r.x1 = 722.8; r.y0 = 545.8; r.y1 = 553.2; }
    // side streets from the north end flush inside the Kingsgate band;
    // Baroness recentered in its corridor (the strip hugged the west buildings)
    // and both normalized to standard road width
    if (near(r.x0, 445.3, 3) && near(r.y1, 553.2, 3)) { r.y1 = 550; r.x0 = 451.9; r.x1 = 459.3; }
    if (near(r.x0, 559.3, 3) && near(r.y1, 542.1, 3)) { r.y1 = 550; r.x0 = 560.75; r.x1 = 568.15; }
    // Millbranch Park Dr Ts into S Millbranch — no poke west past it
    if (near(r.y0, 323.3, 2) && r.x0 < 430) r.x0 = 433.3;
    // New Gate Drive runs from Kingsgate down to New Gate Dr S and stops (Map.pdf
    // shows nothing between it and Millbranch Park — no stub at the 3567 bldg)
    if (near(r.x0, 992.3, 2) && near(r.y0, 318.7, 3)) { r.y0 = 349.8; r.y1 = 549.5; }
    // Kingsgate east: starts flush at the office vertical, runs to its true end
    if (near(r.y0, 349.8, 2) && (r.x1 - r.x0) > 200) { r.x0 = 714.2; r.x1 = 1072; }
    // S Millbranch starts at Long Bow — nothing continues straight past it
    if (near(r.x0, 433.3, 2) && (r.y1 - r.y0) > 100) r.y0 = 217.4;
    // Berwind Drive: starts where it turns right into Queensland, runs down to
    // Chessway — it does not continue north of Queensland or reach Kingsgate
    if (near(r.x0, 60.3, 2) && (r.y1 - r.y0) > 100) { r.y0 = 427.3; r.y1 = 524; }
    // Berwind Road: only alongside 3735 CC and south (turn left into Cazassa,
    // then on past Duchess to Eglesfield) — no junction with Chessway/Kingsgate
    if (near(r.x0, 39.8, 2) && near(r.y0, 492.8, 3)) r.y0 = 556.2;
    // Chessway's west end turns at Berwind Drive; Kingsgate dead-ends by 3733
    if (near(r.y0, 516.6, 2) && r.x0 < 45) r.x0 = 60.3;
    if (near(r.y0, 545.8, 3) && r.x0 < 45) r.x0 = 103;
    // Liverpool runs from Devon down to Millbranch Park and turns into it — no further
    if (near(r.x0, 1147.3, 2) && near(r.y0, 111.5, 4)) { r.y0 = 168.3; r.y1 = 330.7; }
  }
  // sidewalk stub east of 3548 MBR (Map.pdf draws no road there)
  for (let i = roadRects.length - 1; i >= 0; i--) {
    const r = roadRects[i];
    if (near(r.y0, 147.1, 2) && r.x0 > 1050) roadRects.splice(i, 1);
  }
  // stray 4pt speck below Kingsgate near 3582
  for (let i = roadRects.length - 1; i >= 0; i--) {
    const r = roadRects[i];
    if ((r.x1 - r.x0) < 6 && (r.y1 - r.y0) < 6) roadRects.splice(i, 1);
  }
  // remove the sliver square below Eglesfield next to 3682
  for (let i = roadRects.length - 1; i >= 0; i--) {
    const r = roadRects[i];
    if (near(r.x0, 395.4, 2) && near(r.y0, 668.8, 2)) roadRects.splice(i, 1);
  }
  // consistent setbacks: several streets sat flush against one building row with
  // a wide gap on the other side — recenter each band between the rows it serves
  // (building positions are ground truth; the streets get the nudge)
  {
    const hshift = (yMatch, dy) => {
      for (const r of roadRects)
        if ((r.x1 - r.x0) > (r.y1 - r.y0) && Math.abs(r.y0 - yMatch) < 1.6) { r.y0 += dy; r.y1 += dy; }
    };
    hshift(168.3, -3.3);   // Devon
    hshift(323.3, 2.7);    // Millbranch Park
    hshift(471.8, -3.4);   // Quill
    hshift(516.6, -3.5);   // Chessway
    hshift(545.8, -2);     // Kingsgate (straight west run)
    hshift(616.3, -4);     // Duchess (both segments)
    hshift(660.5, -3.4);   // Eglesfield
    // Victoria Drive: recenter within its corridor
    for (const r of roadRects) if (near(r.x0, 340.3, 2) && (r.y1 - r.y0) > 100) { r.x0 = 343.1; r.x1 = 350.5; }
    // re-flush junction ends onto the shifted bands
    for (const r of roadRects) {
      if (near(r.x0, 60.3, 2) && r.y1 > 500) r.y1 = 520.5;      // Berwind Dr → Chessway
      if (near(r.x0, 714.2, 2) && r.y1 > 540) r.y1 = 551.2;     // office corner → Kingsgate
      if (near(r.x0, 343.1, 2) && r.y1 > 540) r.y1 = 551.2;     // Victoria Dr → Kingsgate
      if (near(r.x0, 398.7, 2) && r.y1 > 660) r.y1 = 664.5;     // Victoria Rd → Eglesfield
      if (near(r.x0, 39.8, 2) && r.y1 > 660) r.y1 = 664.5;      // Berwind Rd → Eglesfield
      if (near(r.x0, 1147.3, 2) && r.y1 > 320) r.y1 = 333.4;    // Liverpool corner at MBP
    }
  }
}
console.log('road segments (total, healed):', roadRects.length);

/* ---------------- seeded rng ---------------- */
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/* ================================================================ */
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Avenir Next, Helvetica Neue, sans-serif">`;
svg += `<defs>
<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="5" dy="7" stdDeviation="6" flood-color="#5A5540" flood-opacity="0.30"/></filter>
<filter id="softsm" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="3" dy="4" stdDeviation="3" flood-color="#5A5540" flood-opacity="0.28"/></filter>
<radialGradient id="pagev" cx="50%" cy="42%" r="75%"><stop offset="0%" stop-color="#E3EACB"/><stop offset="100%" stop-color="#D3DEB6"/></radialGradient>
<linearGradient id="roofg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#FFFEFA"/><stop offset="100%" stop-color="#F4EFE1"/></linearGradient>
</defs>`;
svg += `<rect width="${W}" height="${H}" fill="url(#pagev)"/>`;
svg += `<circle cx="${W-380}" cy="380" r="300" fill="none" stroke="rgba(62,90,68,.05)" stroke-width="46"/>`;

/* Days Creek greenway along the property's east edge (bottom in this orientation) */
{
  const pts = [[46, 730], [190, 723], [380, 732], [560, 722], [760, 731], [960, 721], [1120, 729], [1170, 725]];
  const d = 'M ' + pts.map(p => `${tx(p[0]).toFixed(1)} ${ty(p[1]).toFixed(1)}`).join(' L ');
  svg += `<path d="${d}" stroke="#D6E2BB" stroke-width="92" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += `<path d="${d}" stroke="#BFD8A4" stroke-width="58" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/>`;
  svg += `<path d="${d}" stroke="${C.water}" stroke-width="21" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += `<path d="${d}" stroke="#FFFFFF" stroke-width="2.2" opacity=".55" fill="none" stroke-dasharray="16 20"/>`;
  svg += `<text x="${tx(610)}" y="${ty(747)}" font-family="Georgia, serif" font-style="italic" font-size="20" letter-spacing="6" fill="#5E93AC" text-anchor="middle">D a y s   C r e e k</text>`;
}

/* lawn blobs under each block cluster */
let lawns = '';
for (const b of blocks) {
  lawns += `<rect x="${tx(b.x0) - 58}" y="${ty(b.y0) - 42}" width="${(b.x1 - b.x0) * SC + 116}" height="${(b.y1 - b.y0) * SC + 84}" rx="46" fill="${C.lawn}"/>`;
}
// west-boundary green verge: Berwind Rd/Dr and their cross-street junctions sit on
// the beige exterior where road-on-beige is nearly invisible — back them with lawn
lawns += `<rect x="${tx(36)}" y="${ty(383)}" width="${(107 - 36) * SC}" height="${(672 - 383) * SC}" rx="46" fill="${C.lawn}"/>`;
// campus infill panels — fill the road-bounded interiors so the grounds read as
// continuous lawn instead of green islands (roads/buildings draw over these)
for (const [x0, y0, x1, y1] of [
  [67.7, 434.7, 340.3, 471],     // Queensland → Quill (building pad + BW/QU/VI row)
  [67.7, 475, 340.3, 516],       // Quill → Chessway (CH/VI campus)
  [47.2, 518, 346, 549],         // Chessway → Kingsgate (3733–3693 KG row)
  [46, 550, 676, 591.1],         // Kingsgate → Cazassa (CC row)
  [47.2, 598.5, 628.5, 614],     // Cazassa → Duchess median
  [231.4, 598.5, 406.1, 660.5],  // courtyard between the Duchess loops
  [47.2, 618, 231.4, 660.5],     // S Duchess/Eglesfield row
  [406.1, 618, 498, 660.5],      // N Duchess/Eglesfield row
  [680.6, 146, 1147.3, 328],     // north campus: MBR row down to Millbranch Park
  [610, 172, 673.2, 328],        // Singing Trees column strip
  [440.7, 224.8, 673.2, 328],    // west campus: Long Bow → Millbranch Park
  [722.8, 330.7, 1080, 349.8],   // Millbranch Park → Kingsgate strip (to the gate)
  [440.7, 330.7, 714.2, 443.1],  // maintenance field: Millbranch Park → Queensland
  [347.7, 450.5, 451.9, 545.8],  // Victoria → Baroness campus (Queensland → Kingsgate)
  [459.3, 450.5, 714.2, 545.8],  // Baroness → office Kingsgate campus (WX/QL/KG + playground)
  [722.8, 357.2, 772, 549],      // east of the office: 3616/3624 column + building pad
])
  lawns += `<rect x="${tx(x0)}" y="${ty(y0)}" width="${(x1 - x0) * SC}" height="${(y1 - y0) * SC}" rx="24" fill="${C.lawn}"/>`;
svg += `<g opacity="0.95">${lawns}</g>`;
// darker lawn accents
for (const b of blocks) {
  if (rnd() > 0.72) svg += `<rect x="${tx(b.x0) - 20}" y="${ty(b.y0) - 14}" width="${(b.x1 - b.x0) * SC + 40}" height="${(b.y1 - b.y0) * SC + 28}" rx="24" fill="${C.lawn2}" opacity=".6"/>`;
}

/* roads */
for (const r of roadRects) {
  svg += `<rect x="${tx(r.x0) - 2}" y="${ty(r.y0) - 2}" width="${(r.x1 - r.x0) * SC + 4}" height="${(r.y1 - r.y0) * SC + 4}" rx="10" fill="${C.roadEdge}"/>`;
}
for (const r of roadRects) {
  svg += `<rect x="${tx(r.x0)}" y="${ty(r.y0)}" width="${(r.x1 - r.x0) * SC}" height="${(r.y1 - r.y0) * SC}" rx="8" fill="${C.road}"/>`;
}

/* ---------------- amenities & special areas ---------------- */
const obstacles = [];   // pdf-space rects that trees/shrubs must avoid
function slab(x, y, w, h, fill, label, sub, txtFill = '#FFFFFF') {
  obstacles.push({ x0: x, y0: y, x1: x + w, y1: y + h });
  const X = tx(x), Y = ty(y), Wd = w * SC, Ht = h * SC;
  let s = `<g filter="url(#softsm)"><rect x="${X}" y="${Y}" width="${Wd}" height="${Ht}" rx="8" fill="${fill}"/></g>`;
  s += `<rect x="${X}" y="${Y + Ht - 6}" width="${Wd}" height="6" rx="3" fill="rgba(0,0,0,.14)"/>`;
  s += `<text x="${X + Wd / 2}" y="${Y + Ht / 2 + (sub ? -2 : 5)}" text-anchor="middle" font-size="14" font-weight="700" letter-spacing="1.2" fill="${txtFill}">${label}</text>`;
  if (sub) s += `<text x="${X + Wd / 2}" y="${Y + Ht / 2 + 15}" text-anchor="middle" font-size="10.5" letter-spacing=".6" fill="${txtFill}" opacity=".85">${sub}</text>`;
  return s;
}
let amenities = '';
amenities += slab(519, 334.5, 51, 10, '#5B7C99', 'MAINTENANCE SHOP');
// its street address, in the same pill the leasing office wears
{
  const cx = tx(519 + 25.5), top = ty(344.5) + 7;
  amenities += `<rect x="${cx - 88}" y="${top}" width="176" height="18" rx="9" fill="#FFFFFF" fill-opacity=".92" stroke="rgba(90,84,66,.25)" stroke-width=".7"/>`;
  amenities += `<text x="${cx}" y="${top + 13}" text-anchor="middle" font-size="11" font-weight="700" letter-spacing=".8" fill="#4F6E88">3640 MILLBRANCH PARK DR</text>`;
}
// leasing offices (north campus + south) — nudged into the clear beside buildings
function placeClear(x, y, w, h) {
  const hits = (X, Y) =>
    blocks.some(b => X < b.x1 + 3 && X + w > b.x0 - 3 && Y < b.y1 + 3 && Y + h > b.y0 - 3) ||
    roadRects.some(r => X < r.x1 + 1 && X + w > r.x0 - 1 && Y < r.y1 + 1 && Y + h > r.y0 - 1) ||
    obstacles.some(o => X < o.x1 + 2 && X + w > o.x0 - 2 && Y < o.y1 + 2 && Y + h > o.y0 - 2);
  if (!hits(x, y)) return [x, y];
  for (let d = 2; d <= 80; d += 2)
    for (const [dx, dy] of [[-d, 0], [d, 0], [0, -d], [0, d], [-d, -d], [-d, d]])
      if (!hits(x + dx, y + dy)) return [x + dx, y + dy];
  return [x, y];
}
// drawn exactly as in Map.pdf: an attached wing on the west side of the
// 3613 Kingsgate building (main office) and the 3644 Duchess building (south office)
function officeWing(key, sub) {
  const b = blocks.find(bb => bb.key === key);
  const wingW = 10.3;
  obstacles.push({ x0: b.x0 - wingW - 1, y0: b.y0 - 1, x1: b.x0, y1: b.y1 + (sub ? 7 : 1) });
  const X = tx(b.x0 - wingW), Y = ty(b.y0), Wd = wingW * SC, Ht = (b.y1 - b.y0) * SC;
  let s = `<g filter="url(#softsm)"><rect x="${X}" y="${Y}" width="${Wd}" height="${Ht}" rx="4" fill="${C.olive}"/></g>`;
  s += `<rect x="${X}" y="${Y}" width="${Wd}" height="${Ht}" rx="4" fill="none" stroke="${C.oliveDark}" stroke-width="1.4"/>`;
  s += `<rect x="${X + 2.5}" y="${Y + Ht - 6}" width="${Wd - 5}" height="4" rx="2" fill="rgba(0,0,0,.16)"/>`;
  s += `<text transform="translate(${(X + Wd / 2).toFixed(1)},${(Y + Ht / 2).toFixed(1)}) rotate(90)" text-anchor="middle" dominant-baseline="central" font-size="${Math.min(15, Ht / 11)}" font-weight="700" letter-spacing="2" fill="#FFFFFF">LEASING OFFICE</text>`;
  if (sub) {
    s += `<rect x="${X + Wd / 2 - 66}" y="${Y + Ht + 7}" width="132" height="18" rx="9" fill="#FFFFFF" fill-opacity=".92" stroke="rgba(90,84,66,.25)" stroke-width=".7"/>`;
    s += `<text x="${X + Wd / 2}" y="${Y + Ht + 20}" text-anchor="middle" font-size="11" font-weight="700" letter-spacing=".8" fill="${C.oliveDark}">${sub}</text>`;
  }
  return s;
}
amenities += officeWing('3613 KG', '3619 KINGSGATE DR');
amenities += officeWing('3644 DU', null);
// building pads
for (const [px, py, pw, ph] of [[1008, 199, 36, 11], [447, 291, 36, 11], [726, 415, 36, 11], [73, 488, 36, 11]]) {
  amenities += `<rect x="${tx(px)}" y="${ty(py)}" width="${pw * SC}" height="${ph * SC}" rx="8" fill="#DED9CA" stroke="#B3AC98" stroke-width="1.6" stroke-dasharray="7 5"/>`;
  amenities += `<text x="${tx(px) + pw * SC / 2}" y="${ty(py) + ph * SC / 2 + 4}" text-anchor="middle" font-size="11.5" font-weight="600" letter-spacing="1" fill="#8A8471">BUILDING PAD</text>`;
}
// pool remnants
for (const [px, py] of [[1006, 229], [328, 635]]) {
  amenities += `<rect x="${tx(px)}" y="${ty(py)}" width="${26 * SC}" height="${9 * SC}" rx="9" fill="#CFD8D2" stroke="#A9B5AC" stroke-width="1.5" stroke-dasharray="5 4" opacity=".8"/>`;
  amenities += `<text x="${tx(px) + 13 * SC}" y="${ty(py) + 4.5 * SC + 4}" text-anchor="middle" font-size="10.5" font-weight="600" letter-spacing=".8" fill="#7E8A81">POOL REMNANTS</text>`;
}

// property gate at the east end of Cazassa Drive
{
  const gx = tx(676), gy0 = ty(589.2), gy1 = ty(600.4);
  amenities += `<rect x="${gx - 3}" y="${gy0 - 9}" width="8" height="9" rx="1.5" fill="#8A8471" stroke="#6B6353" stroke-width="1"/>`;
  amenities += `<rect x="${gx - 3}" y="${gy1}" width="8" height="9" rx="1.5" fill="#8A8471" stroke="#6B6353" stroke-width="1"/>`;
  amenities += `<path d="M ${gx + 1} ${gy0 - 2} V ${gy1 + 2}" stroke="#6B6353" stroke-width="1.6" stroke-dasharray="4 3"/>`;
  amenities += `<text x="${gx + 14}" y="${(gy0 + gy1) / 2 + 4}" font-size="10.5" font-style="italic" font-family="Georgia, serif" fill="#8A8471">gate</text>`;
}

// gate + security booth at the east end of Kingsgate Drive
{
  const gx = tx(1069), gy0 = ty(349.8), gy1 = ty(357.2);
  amenities += `<rect x="${gx - 3}" y="${gy0 - 9}" width="8" height="9" rx="1.5" fill="#8A8471" stroke="#6B6353" stroke-width="1"/>`;
  amenities += `<rect x="${gx - 3}" y="${gy1}" width="8" height="9" rx="1.5" fill="#8A8471" stroke="#6B6353" stroke-width="1"/>`;
  amenities += `<path d="M ${gx + 1} ${gy0 - 2} V ${gy1 + 2}" stroke="#6B6353" stroke-width="1.6" stroke-dasharray="4 3"/>`;
  amenities += `<text x="${gx + 1}" y="${gy1 + 24}" text-anchor="middle" font-size="10.5" font-style="italic" font-family="Georgia, serif" fill="#8A8471">gate</text>`;
  // booth on the lawn just north of the gate
  obstacles.push({ x0: 1070, y0: 338.5, x1: 1080, y1: 347.5 });
  amenities += slab(1070.5, 339.5, 9, 7, '#5B7C99', '', null);
  amenities += `<rect x="${tx(1075) - 44}" y="${ty(334.5) - 12}" width="88" height="17" rx="8.5" fill="#FFFFFF" fill-opacity=".92" stroke="rgba(90,84,66,.25)" stroke-width=".7"/>`;
  amenities += `<text x="${tx(1075)}" y="${ty(334.5)}" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing=".8" fill="#4F6E88">SECURITY</text>`;
}

// gate + security booth on Commonwealth Drive between 3584 MBR-1 and 3568 MBR-3
// (the Millbranch entrance). Commonwealth runs vertically here, so the pattern
// above turns 90°: posts flank the road, the dashed bar crosses it.
{
  const gy = ty(157.6), gx0 = tx(911.5), gx1 = tx(921.9);
  amenities += `<rect x="${gx0 - 9}" y="${gy - 3}" width="9" height="8" rx="1.5" fill="#8A8471" stroke="#6B6353" stroke-width="1"/>`;
  amenities += `<rect x="${gx1}" y="${gy - 3}" width="9" height="8" rx="1.5" fill="#8A8471" stroke="#6B6353" stroke-width="1"/>`;
  amenities += `<path d="M ${gx0 - 2} ${gy + 1} H ${gx1 + 2}" stroke="#6B6353" stroke-width="1.6" stroke-dasharray="4 3"/>`;
  amenities += `<text x="${(gx0 + gx1) / 2}" y="${gy + 22}" text-anchor="middle" font-size="10.5" font-style="italic" font-family="Georgia, serif" fill="#8A8471">gate</text>`;
  // booth sits in the middle of the roadway just above (north of) the gate —
  // Commonwealth is wide enough for the checkpoint island, and the flanking
  // lots on both sides are units.
  amenities += slab(912.7, 150, 8, 6.5, '#5B7C99', '', null);
  amenities += `<rect x="${tx(916.7) - 44}" y="${ty(144.5) - 12}" width="88" height="17" rx="8.5" fill="#FFFFFF" fill-opacity=".92" stroke="rgba(90,84,66,.25)" stroke-width=".7"/>`;
  amenities += `<text x="${tx(916.7)}" y="${ty(144.5)}" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing=".8" fill="#4F6E88">SECURITY</text>`;
}

// playgrounds (per Google Maps): Kingsgate/Wessex courtyard + behind the middle Claymore building
function playground(x, y, w, h) {
  const [px, py] = placeClear(x, y, w, h);
  obstacles.push({ x0: px - 1, y0: py - 1, x1: px + w + 1, y1: py + h + 5 });
  const X = tx(px), Y = ty(py), Wd = w * SC, Ht = h * SC;
  const cx = X + Wd / 2, cy = Y + Ht / 2;
  // poured-rubber safety pad: rounded two-tone surface with inset border
  const R = Math.min(Wd, Ht);
  let s2 = `<g filter="url(#softsm)"><rect x="${X}" y="${Y}" width="${Wd}" height="${Ht}" rx="${(R * 0.28).toFixed(1)}" fill="#EAC1A0"/></g>`;
  s2 += `<rect x="${X}" y="${Y}" width="${Wd}" height="${Ht}" rx="${(R * 0.28).toFixed(1)}" fill="none" stroke="#D8A87E" stroke-width="2"/>`;
  s2 += `<rect x="${X + 5}" y="${Y + 5}" width="${Wd - 10}" height="${Ht - 10}" rx="${(R * 0.28 - 4).toFixed(1)}" fill="none" stroke="#F4DDC6" stroke-width="1.5"/>`;
  s2 += `<circle cx="${X + Wd * 0.32}" cy="${Y + Ht * 0.38}" r="${(R * 0.17).toFixed(1)}" fill="#F2D4B8"/>`;
  s2 += `<circle cx="${X + Wd * 0.7}" cy="${Y + Ht * 0.6}" r="${(R * 0.21).toFixed(1)}" fill="#F2D4B8"/>`;
  const horiz = Wd >= Ht;
  const at = f => horiz ? [X + Wd * f, cy] : [cx, Y + Ht * f];
  const [s1x, s1y] = at(0.24), [s2x, s2y] = at(0.56), [s3x, s3y] = at(0.85);
  // A-frame swing set, top view: side frames + crossbar + two hanging seats
  s2 += `<rect x="${s1x - 16}" y="${s1y - 9}" width="4.6" height="16" rx="1.8" fill="#4E6E80"/>`;
  s2 += `<rect x="${s1x + 11.4}" y="${s1y - 9}" width="4.6" height="16" rx="1.8" fill="#4E6E80"/>`;
  s2 += `<path d="M ${s1x - 13.7} ${s1y - 1} H ${s1x + 13.7}" stroke="#4E6E80" stroke-width="3.2" stroke-linecap="round"/>`;
  s2 += `<path d="M ${s1x - 6.5} ${s1y - 1} v 6 M ${s1x + 6.5} ${s1y - 1} v 6" stroke="#7FA0B5" stroke-width="1.3"/>`;
  s2 += `<rect x="${s1x - 9.7}" y="${s1y + 5}" width="6.4" height="4.4" rx="2" fill="#C3493E"/>`;
  s2 += `<rect x="${s1x + 3.3}" y="${s1y + 5}" width="6.4" height="4.4" rx="2" fill="#C3493E"/>`;
  // climber deck (rotated square) with straight slide chute + ladder rungs
  s2 += `<rect x="${s2x - 8}" y="${s2y - 8}" width="16" height="16" rx="4.5" transform="rotate(45 ${s2x} ${s2y})" fill="#3E7F73" stroke="#2F6459" stroke-width="1.4"/>`;
  s2 += `<path d="M ${s2x + 9} ${s2y} h 13" stroke="#C3493E" stroke-width="8" stroke-linecap="round"/>`;
  s2 += `<path d="M ${s2x + 9} ${s2y} h 12" stroke="#F5E3D2" stroke-width="3.6" stroke-linecap="round"/>`;
  s2 += `<path d="M ${s2x - 17} ${s2y - 3.2} h 7 M ${s2x - 17} ${s2y} h 7 M ${s2x - 17} ${s2y + 3.2} h 7" stroke="#6B6353" stroke-width="1.3"/>`;
  s2 += `<circle cx="${s2x}" cy="${s2y}" r="2.4" fill="#FFFFFF" opacity=".85"/>`;
  // seesaw + spring riders
  s2 += `<path d="M ${s3x - 11} ${s3y - 4} L ${s3x + 11} ${s3y + 4}" stroke="#33406A" stroke-width="3.6" stroke-linecap="round"/>`;
  s2 += `<circle cx="${s3x}" cy="${s3y}" r="3" fill="#5EA79F" stroke="#47857B" stroke-width="1.2"/>`;
  s2 += `<circle cx="${s3x + 9}" cy="${s3y - 9}" r="3" fill="#C3493E"/><circle cx="${s3x + 9}" cy="${s3y - 9}" r="1.1" fill="#FFFFFF"/>`;
  s2 += `<circle cx="${s3x - 9}" cy="${s3y + 9}" r="3" fill="#E0A32E"/><circle cx="${s3x - 9}" cy="${s3y + 9}" r="1.1" fill="#FFFFFF"/>`;
  s2 += `<rect x="${cx - 44}" y="${Y + Ht + 6}" width="88" height="17" rx="8.5" fill="#FFFFFF" fill-opacity=".92" stroke="rgba(90,84,66,.25)" stroke-width=".7"/>`;
  s2 += `<text x="${cx}" y="${Y + Ht + 18}" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing="1" fill="#B07A28">PLAYGROUND</text>`;
  return s2;
}
amenities += playground(626, 474, 34, 32);     // Kingsgate ↔ Wessex courtyard
amenities += playground(498, 230.5, 40, 15);   // behind middle Claymore building, near S Millbranch

// flower beds
function flowerbed(x, y) {
  const [nx, ny] = placeClear(x - 3.6, y - 2.3, 7.2, 4.6);   // nudge off buildings/roads/amenities
  const X = tx(nx + 3.6), Y = ty(ny + 2.3);
  let s = `<ellipse cx="${X}" cy="${Y}" rx="15" ry="9" fill="#6C9B58"/>`;
  const cols = ['#E4788C', '#F0D77B', '#FFFFFF', '#D66853', '#E4788C'];
  for (let i = 0; i < 5; i++) s += `<circle cx="${(X - 10 + i * 5 + jitB()).toFixed(1)}" cy="${(Y - 2 + jitB()).toFixed(1)}" r="2.3" fill="${cols[i]}"/>`;
  return s;
}
const jitB = () => (rnd() - 0.5) * 5;
const SHOW_FLOWERBEDS = false;   // hidden for now
for (const [fx, fy] of [[634, 363], [676, 384], [524, 344], [548, 620], [600, 670], [643, 469], [532, 228], [582, 254]])
  if (SHOW_FLOWERBEDS) amenities += flowerbed(fx, fy);

// dashed footpaths through the campus and to the playgrounds (hidden for now)
const SHOW_PATHS = false;
if (SHOW_PATHS) {
  const path = (a, b) => `<path d="M ${tx(a[0])} ${ty(a[1])} L ${tx(b[0])} ${ty(b[1])}" stroke="#CBC2A6" stroke-width="2.6" stroke-dasharray="7 6" stroke-linecap="round" fill="none"/>`;
  let paths = '';
  paths += path([645, 382], [645, 444]);
  paths += path([544, 342], [544, 358]) + path([518, 230], [518, 224]);
  paths += path([660, 490], [714, 490]);
  svg += paths;   // under the buildings/amenities layer
}

/* ---------------- buildings ---------------- */
// Per-building siding tints: the thin outline around a building block follows
// its real-world siding color when listed here; everything else keeps the
// default C.bldEdge. Keyed by building number (covers every street it fronts).
const SIDING = {
  // Per-building parapet-band tints go here, e.g. 3616: '#7E99AE'.
};
// Mix two hex colors (t = share of `b`) — used to wash a siding color into the
// roof face without drowning the navy unit labels.
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0').toUpperCase()}`;
}
// AvenirNext-DemiBold @10 glyph advances (CoreText, scratchpad/advances.swift)
// for centering the unit-label pair; digits are uniform 6.1, letters vary.
const CODE_ADV = {
  '0': 6.1, '1': 6.1, '2': 6.1, '3': 6.1, '4': 6.1, '5': 6.1, '6': 6.1, '7': 6.1, '8': 6.1, '9': 6.1, '-': 3.2,
  A: 7.06, B: 6.47, C: 6.96, D: 7.64, E: 6.1, F: 5.73, G: 7.73, H: 7.39, I: 2.82, J: 4.98, K: 6.89, L: 5.11,
  M: 9.2, N: 7.8, O: 8.49, P: 6.1, Q: 8.52, R: 6.29, S: 5.74, T: 5.68, U: 7.14, V: 6.53, W: 10.04, X: 6.58,
  Y: 6.22, Z: 6.11,
};
const baseTint = { b1: '#EFDFC0', b2: '#F0D2C4', b34: '#CEE0DA' };
let bldLayer = '', cellLayer = '', textLayer = '', shrubLayer = '';
for (const b of blocks) {
  const X = tx(b.x0) + 1.5, Y = ty(b.y0) + 1.5;
  const Wd = (b.x1 - b.x0) * SC - 3, Ht = (b.y1 - b.y0) * SC - 3;
  bldLayer += `<g filter="url(#soft)"><rect x="${X}" y="${Y}" width="${Wd}" height="${Ht}" rx="5" fill="url(#roofg)"/></g>`;
  const ins = 5.5;
  // Siding buildings: paint only the parapet band — the thin ring between the
  // outer border line and the inner roof outline — with the siding color. A
  // stroked rect centered on the ring covers exactly that band; the roof face,
  // border line, and dividers keep the shared palette.
  const sidingBase = SIDING[b.cells[0]?.bld];
  if (sidingBase) {
    bldLayer += `<rect x="${X + ins / 2}" y="${Y + ins / 2}" width="${Wd - ins}" height="${Ht - ins}" rx="4" fill="none" stroke="${sidingBase}" stroke-width="${ins}"/>`;
  }
  b.divider = C.divider;
  bldLayer += `<rect x="${X}" y="${Y}" width="${Wd}" height="${Ht}" rx="5" fill="none" stroke="${C.bldEdge}" stroke-width="1.6"/>`;
  // parapet roof detail: inner outline + mitred corner ticks
  bldLayer += `<rect x="${X + ins}" y="${Y + ins}" width="${Wd - 2 * ins}" height="${Ht - 2 * ins}" rx="3" fill="none" stroke="#E7E0CD" stroke-width="1.3"/>`;
  bldLayer += `<path d="M ${X + 1.2} ${Y + 1.2} l ${ins - 1} ${ins - 1} M ${X + Wd - 1.2} ${Y + 1.2} l ${-(ins - 1)} ${ins - 1} M ${X + 1.2} ${Y + Ht - 1.2} l ${ins - 1} ${-(ins - 1)} M ${X + Wd - 1.2} ${Y + Ht - 1.2} l ${-(ins - 1)} ${-(ins - 1)}" stroke="#E7E0CD" stroke-width="1.2"/>`;
  // (type-tinted base edge removed at user request)
  // entry shrubs on the lawn beside the building
  const nsh = 1 + Math.floor(rnd() * 3);
  for (let s = 0; s < nsh; s++) {
    const side = rnd();
    let sx, sy;
    if (side < 0.4) { sx = X + 12 + rnd() * (Wd - 24); sy = Y - 9 - rnd() * 4; }
    else if (side < 0.8) { sx = X + 12 + rnd() * (Wd - 24); sy = Y + Ht + 9 + rnd() * 4; }
    else { sx = rnd() < 0.5 ? X - 11 : X + Wd + 11; sy = Y + 10 + rnd() * (Ht - 20); }
    const rr = 3.2 + rnd() * 2.6;
    if (!roadRects.some(r => sx > tx(r.x0) - 3 && sx < tx(r.x1) + 3 && sy > ty(r.y0) - 3 && sy < ty(r.y1) + 3) &&
        !obstacles.some(o => sx > tx(o.x0) - 4 && sx < tx(o.x1) + 4 && sy > ty(o.y0) - 4 && sy < ty(o.y1) + 4) &&
        !blocks.some(bb => sx > tx(bb.x0) - rr - 2 && sx < tx(bb.x1) + rr + 2 && sy > ty(bb.y0) - rr - 2 && sy < ty(bb.y1) + rr + 2))
      shrubLayer += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${rr.toFixed(1)}" fill="${C.tree[Math.floor(rnd() * C.tree.length)]}" stroke="${C.treeDark}" stroke-width="1"/>`;
  }
  // unit cells
  for (const u of b.cells) {
    const l = u.cx - CW / 2, t = u.cy - CH / 2;
    // The label centers on the cell's VISIBLE face: sides that sit on the
    // building boundary lose the 1.5px rect inset + 5.5px parapet band, so the
    // perceived box is ~7px narrower there and the center shifts inward.
    const INSET = 7;
    const leftEdge = Math.abs(l - b.x0) <= 1, rightEdge = Math.abs(l + CW - b.x1) <= 1;
    const topEdge = Math.abs(t - b.y0) <= 1, bottomEdge = Math.abs(t + CH - b.y1) <= 1;
    const cx = tx(u.cx) + (leftEdge ? INSET / 2 : 0) - (rightEdge ? INSET / 2 : 0);
    const cy = ty(u.cy) + (topEdge ? INSET / 2 : 0) - (bottomEdge ? INSET / 2 : 0);
    if (Math.abs(l - b.x0) > 1) cellLayer += `<path d="M ${tx(l)} ${ty(Math.max(t, b.y0)) + 3} V ${ty(Math.min(t + CH, b.y1)) - 3}" stroke="${b.divider}" stroke-width="1.4"/>`;
    if (Math.abs(t - b.y0) > 1) cellLayer += `<path d="M ${tx(Math.max(l, b.x0)) + 3} ${ty(t)} H ${tx(Math.min(l + CW, b.x1)) - 3}" stroke="${b.divider}" stroke-width="1.4"/>`;
    // One line, two tones: "3580 PJ-3" — building number flush-right against
    // the split point, street-unit code flush-left, sharing a baseline. The
    // opposing anchors keep the pair adjacent whatever each half measures, and
    // the split point comes from real Avenir Next advances (CoreText-measured;
    // the Skia renderer and macOS browsers both draw that family) so the
    // combined line centers on the cell square itself, parapet inset ignored.
    const numW = u.bld.length * 7.429;                                   // AvenirNext-Bold 11.5, digits
    const codeStr = `${u.code}-${u.unit}`;
    const codeW = [...codeStr].reduce(
      (w, ch) => w + (CODE_ADV[ch] ?? 6.5) + 0.4, -0.4);                 // AvenirNext-DemiBold 10 + tracking
    const GAP = 5;
    const split = cx - (numW + GAP + codeW) / 2 + numW;
    // data-pair-*: the Skia renderer re-centers the pair with its OWN measured
    // font widths (see plan-picture.ts) — the static split below only serves
    // plain-SVG viewers like the admin map.
    textLayer += `<text x="${split.toFixed(1)}" y="${cy + 4}" text-anchor="end" data-pair="lead" data-pair-cx="${cx.toFixed(1)}" data-pair-gap="${GAP}" font-family="Avenir Next" font-size="11.5" font-weight="700" fill="${C.num}">${u.bld}</text>`;
    textLayer += `<text x="${(split + GAP).toFixed(1)}" y="${cy + 4}" text-anchor="start" data-pair="tail" font-family="Avenir Next" font-size="10" font-weight="600" letter-spacing=".4" fill="${C.types[b.type]}">${codeStr}</text>`;
  }
}
const SHOW_SHRUBS = false;   // entry shrubs hidden for now
svg += bldLayer + cellLayer + textLayer + (SHOW_SHRUBS ? shrubLayer : '') + amenities;

/* ---------------- trees (rejection-sampled on lawns) ---------------- */
function treeAt(x, y, r) {
  let s = `<ellipse cx="${x + r * 0.35}" cy="${y + r * 0.4}" rx="${r * 1.08}" ry="${r * 0.85}" fill="${C.trunkShadow}"/>`;
  const lobes = 4 + Math.floor(rnd() * 2);
  s += `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.treeDark}"/>`;
  const base = C.tree[Math.floor(rnd() * C.tree.length)];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rnd(), d = r * 0.32;
    s += `<circle cx="${x + Math.cos(a) * d}" cy="${y + Math.sin(a) * d}" r="${r * (0.52 + rnd() * 0.18)}" fill="${i % 2 ? base : C.tree[Math.floor(rnd() * C.tree.length)]}"/>`;
  }
  s += `<circle cx="${x - r * 0.25}" cy="${y - r * 0.28}" r="${r * 0.4}" fill="rgba(255,255,255,.18)"/>`;
  return s;
}
let treeLayer = '';
const SHOW_TREES = false;   // trees hidden for now
if (SHOW_TREES) {
  const placed = [];
  const clear = (x, y, rr) =>
    !blocks.some(b => x > tx(b.x0) - rr * 1.45 - 4 && x < tx(b.x1) + rr * 1.45 + 4 && y > ty(b.y0) - rr * 1.45 - 4 && y < ty(b.y1) + rr * 1.45 + 4) &&
    !roadRects.some(r => x > tx(r.x0) - rr * 0.4 && x < tx(r.x1) + rr * 0.4 && y > ty(r.y0) - rr * 0.4 && y < ty(r.y1) + rr * 0.4) &&
    !obstacles.some(o => x > tx(o.x0) - rr * 1.45 - 4 && x < tx(o.x1) + rr * 1.45 + 4 && y > ty(o.y0) - rr * 1.45 - 4 && y < ty(o.y1) + rr * 1.45 + 4) &&
    !placed.some(p => (p[0] - x) ** 2 + (p[1] - y) ** 2 < (p[2] + rr) ** 2 * 1.05);
  const onLawn = (x, y) => blocks.some(b => x > tx(b.x0) - 60 && x < tx(b.x1) + 60 && y > ty(b.y0) - 46 && y < ty(b.y1) + 46);
  let tries = 0, count = 0;
  while (tries++ < 26000 && count < 390) {
    const x = MX + rnd() * (W - 2 * MX), y = MY + rnd() * (H - MY - 70);
    const r = 10 + rnd() * 10;
    if (onLawn(x, y) && clear(x, y, r)) { treeLayer += treeAt(x, y, r); placed.push([x, y, r]); count++; }
  }
  console.log('trees:', count);
}
// creek-bank trees along the greenway
if (SHOW_TREES) {
  for (let x = 80; x < 1160; x += 82) treeLayer += treeAt(tx(x + (rnd() - 0.5) * 30), ty(742 + (rnd() - 0.5) * 9), 9 + rnd() * 6);
  for (let x = 700; x < 1150; x += 92) treeLayer += treeAt(tx(x + (rnd() - 0.5) * 30), ty(706 + (rnd() - 0.5) * 8), 7 + rnd() * 5);
}
// real trees: positions detected from aerial imagery (Esri World Imagery),
// georeferenced onto Map.pdf space via OSM road intersections — see trees.json
const SHOW_REAL_TREES = false;   // reverted at user request (trees.json still available)
if (SHOW_REAL_TREES) {
  const treesPath = path.join(__dirname, 'trees.json');
  if (fs.existsSync(treesPath)) {
    let drawn = 0;
    for (const [px, py, rpt] of JSON.parse(fs.readFileSync(treesPath, 'utf8')).trees) {
      if (py < 143) continue;   // keep canopy clear of the masthead
      // keep unit labels readable: skip trees whose trunk lands on a building/amenity
      if (blocks.some(b => px > b.x0 - 2 && px < b.x1 + 2 && py > b.y0 - 2 && py < b.y1 + 2)) continue;
      if (obstacles.some(o => px > o.x0 - 1 && px < o.x1 + 1 && py > o.y0 - 1 && py < o.y1 + 1)) continue;
      treeLayer += treeAt(tx(px), ty(py), Math.min(Math.max(rpt * SC, 7), 24));
      drawn++;
    }
    console.log('real trees drawn:', drawn);
  }
}
svg += treeLayer;

/* ---------------- street labels (snapped to road centerlines) ---------------- */
for (const [name, x, y, rot] of streetLabels) {
  let lx = x, ly = y + (rot ? 0 : 3);
  let best = null, bd = 1e9;
  for (const r of roadRects) {
    const horiz = (r.x1 - r.x0) >= (r.y1 - r.y0);
    if (horiz !== (rot === 0)) continue;
    const perp = horiz ? Math.abs((r.y0 + r.y1) / 2 - ly) : Math.abs((r.x0 + r.x1) / 2 - lx);
    const inSpan = horiz ? (lx > r.x0 - 10 && lx < r.x1 + 10) : (ly > r.y0 - 10 && ly < r.y1 + 10);
    const d = perp + (inSpan ? 0 : 500);
    if (d < bd) { bd = d; best = r; }
  }
  if (best && bd < 16) {
    const half = name.length * 1.3 + 5;
    if (!rot) {
      ly = (best.y0 + best.y1) / 2;
      if (best.x1 - best.x0 > 2 * half) lx = Math.min(Math.max(lx, best.x0 + half), best.x1 - half);
    } else {
      lx = (best.x0 + best.x1) / 2;
      if (best.y1 - best.y0 > 2 * half) ly = Math.min(Math.max(ly, best.y0 + half), best.y1 - half);
    }
  }
  const X = tx(lx), Y = ty(ly);
  svg += `<text transform="translate(${X.toFixed(1)},${Y.toFixed(1)})${rot ? ` rotate(${rot})` : ''}" font-size="13.5" font-weight="600" letter-spacing="2.6" fill="${C.dim}" text-anchor="middle" dominant-baseline="central" paint-order="stroke" stroke="${C.road}" stroke-width="4">${name}</text>`;
}

/* ---------------- legend / footer (header band removed — the app provides
   its own chrome, and on screen the lockup was dead space above the map) */
// legend card in the map's natural empty top-left corner (hidden for now)
const SHOW_LEGEND = false;
if (SHOW_LEGEND) {
  const lx = 110, ly = 260, lw = 560, lh = 620;
  svg += `<g transform="translate(${lx},${ly})" filter="url(#softsm)">
  <rect width="${lw}" height="${lh}" rx="16" fill="#FDFBF2" stroke="#C9C1AA" stroke-width="2"/></g>`;
  svg += `<g transform="translate(${lx},${ly})">
  <text x="34" y="56" font-size="24" font-weight="700" letter-spacing="6" fill="#3E5A44">MAP LEGEND</text>
  <path d="M 34 76 L ${lw-34} 76" stroke="#DAD3BD" stroke-width="1.5"/>`;
  const rowsL = [
    [C.types.b1, 'One Bedroom Homes', 'CC &#8226; DU &#8226; EG'],
    [C.types.b2, 'Two Bedroom Homes', 'CL &#8226; CW &#8226; DE &#8226; LB &#8226; LP &#8226; MBP &#8226; MBR &#8226; ST'],
    [C.types.b34, 'Three &#38; Four Bedroom Homes', 'BA &#8226; KG &#8226; NG &#8226; PJ &#8226; QL &#8226; QU &#8226; VI &#8226; WD &#8226; WX &#8230;'],
  ];
  rowsL.forEach(([c, t, sub], i) => {
    const yy = 112 + i * 66;
    svg += `<g transform="translate(34,${yy})"><rect width="34" height="22" rx="5" fill="${c}"/>
    <text x="50" y="16" font-size="19" font-weight="600" fill="#4B463A">${t}</text>
    <text x="50" y="38" font-size="13" fill="#8A8471" letter-spacing="1">${sub}</text></g>`;
  });
  svg += `<path d="M 34 ${112 + 198} L ${lw-34} ${112 + 198}" stroke="#DAD3BD" stroke-width="1.5"/>`;
  const icons = [
    [C.olive, 'Leasing Office &#8226; 3619 Kingsgate Dr'],
    ['#F2E4BC', 'Playground'],
    ['#5B7C99', 'Maintenance Shop'], ['#DED9CA', 'Building Pad &#8212; future homes'],
    ['#CFD8D2', 'Pool Remnants'],
  ];
  icons.forEach(([c, t], i) => {
    const yy = 336 + i * 36;
    svg += `<g transform="translate(34,${yy})"><rect width="26" height="17" rx="4" fill="${c}" stroke="rgba(90,84,66,.2)" stroke-width=".8"/><text x="42" y="14" font-size="16.5" fill="#4B463A">${t}</text></g>`;
  });
  svg += `<text x="34" y="${lh - 24}" font-size="13.5" font-style="italic" font-family="Georgia, serif" fill="#8A8471">Unit codes follow street names &#8212; e.g. 3644 DU-1 is unit 1, building 3644, Duchess Drive.</text>`;
  svg += `</g>`;
}
// small north arrow in the header
{
  const nx = W - 120, ny = 75;
  svg += `<g transform="translate(${nx},${ny})">
  <circle r="34" fill="#FDFBF2" stroke="#C9C1AA" stroke-width="2"/>
  <polygon points="22,0 -8,9 -2,0 -8,-9" fill="${C.accent}"/>
  <text x="-20" y="5.5" font-size="15" font-weight="700" fill="#3E5A44">N</text>
  </g>`;
}
// decorative compass rose in the open corner (north = right, matching Map.pdf)
{
  const cx = tx(1104), cy = ty(650);
  let rose = `<g transform="translate(${cx.toFixed(1)},${cy.toFixed(1)})">`;
  rose += `<circle r="112" fill="#FBF8EC" stroke="#C9C1AA" stroke-width="2.4"/>`;
  rose += `<circle r="97" fill="none" stroke="#DAD3BD" stroke-width="1.2"/>`;
  rose += `<circle r="58" fill="none" stroke="#E4DECA" stroke-width="1"/>`;
  for (let i = 0; i < 16; i++) rose += `<path d="M 0 -104 v 8" stroke="#B8B09A" stroke-width="${i % 4 ? 1.2 : 2.2}" transform="rotate(${i * 22.5})"/>`;
  rose += `<g transform="rotate(90)">`;                                    // rose north points right
  for (let i = 0; i < 4; i++) rose += `<g transform="rotate(${45 + i * 90})"><polygon points="0,-62 9,-11 0,0 -9,-11" fill="#D8D1BA"/><polygon points="0,-62 4,-12 0,-4" fill="#C2BA9F"/></g>`;
  for (let i = 0; i < 4; i++) rose += `<g transform="rotate(${i * 90})"><polygon points="0,-90 12,-14 0,0 -12,-14" fill="${i === 0 ? C.accent : '#EFE9D6'}" stroke="${i === 0 ? '#A83830' : '#B8B09A'}" stroke-width="1.1"/><polygon points="0,-90 6,-15 0,-5" fill="rgba(0,0,0,.16)"/></g>`;
  rose += `</g><circle r="7.5" fill="#FDFBF2" stroke="#6B6353" stroke-width="1.8"/>`;
  rose += `<text x="128" y="7" font-size="24" font-weight="700" fill="${C.accent}" text-anchor="middle" font-family="Georgia, serif">N</text>`;
  rose += `<text x="-126" y="7" font-size="19" font-weight="600" fill="#8A8471" text-anchor="middle" font-family="Georgia, serif">S</text>`;
  rose += `<text x="0" y="-122" font-size="19" font-weight="600" fill="#8A8471" text-anchor="middle" font-family="Georgia, serif">W</text>`;
  rose += `<text x="0" y="138" font-size="19" font-weight="600" fill="#8A8471" text-anchor="middle" font-family="Georgia, serif">E</text>`;
  rose += `</g>`;
  svg += rose;
}
// community-at-a-glance card beside the rose (hidden for now)
const SHOW_GLANCE = false;
if (SHOW_GLANCE) {
  const n1 = units.filter(u => u.type === 'b1').length, n2 = units.filter(u => u.type === 'b2').length, n34 = units.filter(u => u.type === 'b34').length;
  const nb = new Set(units.map(u => u.bld + ' ' + u.code)).size;
  const gx = tx(770), gy = ty(592), gw = 500, gh = 320;
  svg += `<g transform="translate(${gx.toFixed(1)},${gy.toFixed(1)})">
  <g filter="url(#softsm)"><rect width="${gw}" height="${gh}" rx="14" fill="#FDFBF2" stroke="#C9C1AA" stroke-width="1.8"/></g>
  <text x="30" y="46" font-size="20" font-weight="700" letter-spacing="4.5" fill="#3E5A44">COMMUNITY AT A GLANCE</text>
  <path d="M 30 62 L ${gw-30} 62" stroke="#DAD3BD" stroke-width="1.3"/>
  <text x="30" y="102" font-size="30" font-weight="700" fill="${C.accent}" font-family="Georgia, serif">${units.length}</text>
  <text x="105" y="102" font-size="17" fill="#4B463A">apartment homes in ${nb} buildings</text>
  <g transform="translate(30,130)"><rect width="20" height="14" rx="3" fill="${C.types.b1}"/><text x="30" y="12" font-size="15.5" fill="#4B463A">${n1} one-bedroom homes</text></g>
  <g transform="translate(30,158)"><rect width="20" height="14" rx="3" fill="${C.types.b2}"/><text x="30" y="12" font-size="15.5" fill="#4B463A">${n2} two-bedroom homes</text></g>
  <g transform="translate(30,186)"><rect width="20" height="14" rx="3" fill="${C.types.b34}"/><text x="30" y="12" font-size="15.5" fill="#4B463A">${n34} three &#38; four-bedroom homes</text></g>
  <path d="M 30 214 L ${gw-30} 214" stroke="#DAD3BD" stroke-width="1.3"/>
  <text x="30" y="244" font-size="15" fill="#6E6857">2 Playgrounds &#8226; 2 Leasing Offices</text>
  <text x="30" y="270" font-size="15" fill="#6E6857">Maintenance Shop &#8226; On-site Mail Centers</text>
  <text x="30" y="296" font-size="13.5" font-style="italic" font-family="Georgia, serif" fill="#8A8471">Bordered by Days Creek greenway to the east</text>
  </g>`;
}
// (footer address line removed — the map is an app surface now, not a poster)
svg += `<rect x="14" y="14" width="${W - 28}" height="${H - 28}" fill="none" stroke="#C9C1AA" stroke-width="2.5"/>`;
svg += `<rect x="22" y="22" width="${W - 44}" height="${H - 44}" fill="none" stroke="#C9C1AA" stroke-width="1"/>`;
// corner ornaments
for (const [ox, oy, sx, sy] of [[14, 14, 1, 1], [W - 14, 14, -1, 1], [14, H - 14, 1, -1], [W - 14, H - 14, -1, -1]]) {
  svg += `<g transform="translate(${ox},${oy}) scale(${sx},${sy})">
  <path d="M 0 0 L 34 0 M 0 0 L 0 34" stroke="#3E5A44" stroke-width="3"/>
  <path d="M 8 8 h 18 M 8 8 v 18" stroke="#C3493E" stroke-width="1.6"/>
  <circle cx="8" cy="8" r="2.6" fill="#3E5A44"/>
  </g>`;
}

svg += `</svg>`;

/* ---------------- per-unit coordinate export ----------------
   pdf: Map.pdf page space (points, origin top-left, page 1191x842)
   px:  this map's canvas space (pixels, canvas ${W}x${H})           */
{
  const typeName = { b1: '1BR', b2: '2BR', b34: '3-4BR' };
  const out = units.map(u => ({
    building: u.bld, street: u.code, unit: u.unit, type: typeName[u.type],
    pdf: { x0: +(u.cx - CW / 2).toFixed(2), y0: +(u.cy - CH / 2).toFixed(2), x1: +(u.cx + CW / 2).toFixed(2), y1: +(u.cy + CH / 2).toFixed(2) },
    px: { x0: +tx(u.cx - CW / 2).toFixed(1), y0: +ty(u.cy - CH / 2).toFixed(1), x1: +tx(u.cx + CW / 2).toFixed(1), y1: +ty(u.cy + CH / 2).toFixed(1) },
  })).sort((a, b) => a.street.localeCompare(b.street) || a.building.localeCompare(b.building) || a.unit - b.unit);
  fs.writeFileSync(path.join(__dirname, 'units.json'), JSON.stringify({
    source: 'Map.pdf', generated: 'generate-overhead.mjs',
    cell_pt: { w: CW, h: CH }, pdf_page: { w: 1191, h: 842 }, canvas_px: { w: W, h: H },
    orientation: 'north = +x (right)', count: out.length, units: out,
  }, null, 1));
  const csv = ['building,street,unit,type,pdf_x0,pdf_y0,pdf_x1,pdf_y1,px_x0,px_y0,px_x1,px_y1',
    ...out.map(u => [u.building, u.street, u.unit, u.type, u.pdf.x0, u.pdf.y0, u.pdf.x1, u.pdf.y1, u.px.x0, u.px.y0, u.px.x1, u.px.y1].join(','))].join('\n');
  fs.writeFileSync(path.join(__dirname, 'units.csv'), csv);
  console.log('exported units.json / units.csv —', out.length, 'units');
}

/* ---------------- road coordinate export (same two coordinate spaces) */
{
  const nameFor = r => {
    const horiz = (r.x1 - r.x0) >= (r.y1 - r.y0);
    let best = null, bd = 1e9;
    for (const [name, lx, lyRaw, rot] of streetLabels) {
      if ((rot === 0) !== horiz) continue;
      const ly = lyRaw + (rot ? 0 : 3);
      const perp = horiz ? Math.abs((r.y0 + r.y1) / 2 - ly) : Math.abs((r.x0 + r.x1) / 2 - (lx - 3));
      const inSpan = horiz ? (lx > r.x0 - 10 && lx < r.x1 + 10) : (ly > r.y0 - 10 && ly < r.y1 + 10);
      const d = perp + (inSpan ? 0 : 500);
      if (d < bd) { bd = d; best = name; }
    }
    return bd < 16 ? best : null;
  };
  const out = roadRects.map(r => ({
    name: nameFor(r),
    orientation: (r.x1 - r.x0) >= (r.y1 - r.y0) ? 'horizontal' : 'vertical',
    pdf: { x0: +r.x0.toFixed(2), y0: +r.y0.toFixed(2), x1: +r.x1.toFixed(2), y1: +r.y1.toFixed(2) },
    px: { x0: +tx(r.x0).toFixed(1), y0: +ty(r.y0).toFixed(1), x1: +tx(r.x1).toFixed(1), y1: +ty(r.y1).toFixed(1) },
  })).sort((a, b) => (a.name || '~').localeCompare(b.name || '~') || a.pdf.x0 - b.pdf.x0 || a.pdf.y0 - b.pdf.y0);
  fs.writeFileSync(path.join(__dirname, 'roads.json'), JSON.stringify({
    source: 'Map.pdf + ground-truth corrections', generated: 'generate-overhead.mjs',
    pdf_page: { w: 1191, h: 842 }, canvas_px: { w: W, h: H },
    orientation: 'north = +x (right)', count: out.length, roads: out,
  }, null, 1));
  const csv = ['name,orientation,pdf_x0,pdf_y0,pdf_x1,pdf_y1,px_x0,px_y0,px_x1,px_y1',
    ...out.map(r => [r.name ?? '', r.orientation, r.pdf.x0, r.pdf.y0, r.pdf.x1, r.pdf.y1, r.px.x0, r.px.y0, r.px.x1, r.px.y1].join(','))].join('\n');
  fs.writeFileSync(path.join(__dirname, 'roads.csv'), csv);
  console.log('exported roads.json / roads.csv —', out.length, 'road segments');
}

fs.writeFileSync(path.join(__dirname, 'unitmap.svg'), svg);
fs.writeFileSync(path.join(__dirname, 'unitmap.html'),
  `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${(W/100).toFixed(2)}in ${(H/100).toFixed(2)}in;margin:0}html,body{margin:0;padding:0}svg{display:block}</style></head><body>${svg}</body></html>`);
console.log(`canvas ${W}x${H} — written unitmap.svg / unitmap.html`);
