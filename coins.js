/*
 * Compound /coins: the live molecule.
 *
 * Every coin launched on Compound is one small atom around the Compound token, drawn in the same pixel world as the
 * landing's last frame: one buffer of palette indices, drawn pixel by pixel (no paths, no anti-aliasing, no alpha),
 * shown at a whole number of device pixels per buffer pixel. A coin's nucleus is the SOL in its curve or pool, on a
 * log scale over a fixed set of hand-drawn sizes. A coin on its curve sits unbonded inside a dotted gauge lit to its
 * progress; a graduated coin has a gold ring and a pixel bond to the centre. Bonds are structure only: nothing runs
 * along them.
 *
 * Data: GET /api/coins on load and every 20 s while the tab is visible. Only real changes move: a coin whose SOL
 * grew flashes white (and steps up one size at a time when it crosses a size), a new coin flashes in, and a coin that
 * graduated closes its gauge into a ring, jumps to a bond site if it sat on a float site, then draws its bond. With
 * nothing new on the chain the page stands still. Reduced motion: none of that, the new drawing just replaces the old.
 *
 * Placement: each layout has a fixed, checked set of sites. A bond site has a straight corridor to the centre that
 * no other site touches, so a bond never crosses an atom; float sites are for coins on their curve. Graduated coins
 * take bond sites; coins on their curve take float sites first, then free bond sites. Coins are placed oldest first,
 * each on the first free site in its own order (the layout's order, nudged a little by its mint). A coin keeps its
 * site while the page is open, and this browser remembers it for the next visit. So a coin stays where it is across
 * refreshes, a new coin only fills a free place, and nothing overlaps. When more coins exist than sites, the deepest
 * are drawn and the list has them all.
 *
 * A coin's image, when it has one, shows at 32 px beside its name in the panel and the list; the molecule stays pixels
 * only. A #<mint> in the address selects that coin once it appears (the launch page links here that way).
 *
 * The page holds two sets of words about the token in the middle. With no token in the answer: the plain ones, that it
 * isn't out. With one, which on devnet is a test stand-in: the ones that say so, and its buyback's figures in the panel.
 *
 * DOM: draws into #mol (sized inside #mol-box) and fills the status lines, the details panel and the list.
 * Storage: localStorage 'compound:coins:sites:v2:<layout>' (mint -> site), read and written in try/catch.
 * Defines no globals.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('mol'), box = $('mol-box');
  if (!canvas || !box || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const main = $('coins-main');
  const API = (main && main.getAttribute('data-api')) || '/api/coins';

  const TICK = 1000 / 30, TAU = Math.PI * 2, DEG = Math.PI / 180;
  const REFRESH = 20000, TIMEOUT = 12000;
  const now = () => (window.performance && performance.now ? performance.now() : Date.now());

  /* ------------------------------------------------------------------ palette */
  // 0 empty (the page shows through), 1 gold, 2 orange, 3 violet, 4 white, 5 muted, 6 dim (bonds, unlit dots)
  const HEX = ['12121C', 'F5BD00', 'F54B00', '6E45FF', 'F5F5FF', '9595B2', '6C6C89'];
  const LITTLE = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
  const LUT = new Uint32Array(HEX.length);
  for (let i = 1; i < HEX.length; i++) {
    const r = parseInt(HEX[i].substr(0, 2), 16), g = parseInt(HEX[i].substr(2, 2), 16), b = parseInt(HEX[i].substr(4, 2), 16);
    LUT[i] = LITTLE ? (((255 << 24) | (b << 16) | (g << 8) | r) >>> 0) : (((r << 24) | (g << 16) | (b << 8) | 255) >>> 0);
  }

  /* ------------------------------------------------------------------ pixels */
  // S is the surface being drawn: the molecule's buffer, or a small one for a list icon or a key swatch.
  let S = null;
  function put(x, y, c) { if (x >= 0 && x < S.w && y >= 0 && y < S.h) S.b[y * S.w + x] = c; }
  function get(x, y) { return x >= 0 && x < S.w && y >= 0 && y < S.h ? S.b[y * S.w + x] : -1; }
  function surface(w, h) { return { w: w, h: h, b: new Uint8Array(w * h) }; }

  function mulberry32(a) {
    return function () {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* ------------------------------------------------------------------ rings (as in atom.js) */
  // A circle about the corner point (64, 64) as a clean 8-connected 1 px line; drawn elsewhere by offset.
  function ringRaster(rad) {
    const N = Math.ceil(TAU * rad * 4), A = rad - 0.5, xs = [], ys = [];
    for (let k = 0; k < N; k++) {
      const t = TAU * k / N, px = Math.floor(64 + A * Math.cos(t)), py = Math.floor(64 + A * Math.sin(t)), L = xs.length;
      if (L && xs[L - 1] === px && ys[L - 1] === py) continue;
      xs.push(px); ys.push(py);
    }
    while (xs.length > 1 && xs[xs.length - 1] === xs[0] && ys[ys.length - 1] === ys[0]) { xs.pop(); ys.pop(); }
    let changed = true;
    while (changed) {
      changed = false;
      for (let k = 0; k < xs.length && xs.length > 3; k++) {
        const L = xs.length, p = (k - 1 + L) % L, q = (k + 1) % L;
        if (Math.abs(xs[p] - xs[q]) === 1 && Math.abs(ys[p] - ys[q]) === 1) { xs.splice(k, 1); ys.splice(k, 1); changed = true; k--; }
      }
    }
    return { n: xs.length, x: xs, y: ys };
  }
  const RINGS = [];
  for (let r = 2; r <= 12; r++) RINGS[r] = ringRaster(r);
  function ringAt(cx, cy, r, c) {
    const rg = RINGS[r], dx = cx - 64, dy = cy - 64;
    for (let i = 0; i < rg.n; i++) put(rg.x[i] + dx, rg.y[i] + dy, c);
  }

  /* ------------------------------------------------------------------ bitmaps */
  function bitmap(rows, map) {
    const h = rows.length, w = rows[0].length, b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = map[rows[y].charAt(x)] || 0;
    return { w: w, h: h, b: b };
  }
  const SPR = { G: 1, O: 2, W: 4 };
  const PROTON = bitmap(['.GG.', 'GWGG', 'GGGO', '.GO.'], SPR);
  const NUC1 = bitmap(['GG', 'GO'], SPR);
  function blit(bm, x, y, white) {
    for (let i = 0; i < bm.b.length; i++) if (bm.b[i]) put(x + i % bm.w, y + ((i / bm.w) | 0), white ? 4 : bm.b[i]);
  }
  function inDisc(dx, dy, r) { const X = dx + 0.5, Y = dy + 0.5; return X * X + Y * Y < r * r; }
  // A nucleus seen from far away (atom.js): radius 1 and 2 are sprites; larger, a gold ball with a darker rim, a few
  // neutron pixels and a highlight at the top left.
  function coinNucleus(cx, cy, r, white) {
    if (r <= 2) { blit(r <= 1 ? NUC1 : PROTON, cx - r, cy - r, white); return; }
    for (let dy = -r; dy < r; dy++) {
      for (let dx = -r; dx < r; dx++) {
        if (!inDisc(dx, dy, r)) continue;
        let c;
        if (!inDisc(dx + 1, dy + 1, r)) c = 2;
        else c = ((dy & 1) && ((dx + (((dy - 1) >> 1) & 1) * 2) & 3) === 1 && dx + dy > 1 - r) ? 2 : 1;
        put(cx + dx, cy + dy, white ? 4 : c);
      }
    }
    if (!white) { const h = (r >> 1) + 1; put(cx - h, cy - h, 4); if (r >= 5) put(cx - h + 1, cy - h, 4); }
  }

  /* ------------------------------------------------------------------ the glyph font (3x5, as in atom.js) */
  const ON = { '#': 1 };
  const FONT = {
    A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'], C: ['.##', '#..', '#..', '#..', '.##'],
    D: ['##.', '#.#', '#.#', '#.#', '##.'], E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'],
    G: ['.##', '#..', '#.#', '#.#', '.##'], H: ['#.#', '#.#', '###', '#.#', '#.#'], I: ['###', '.#.', '.#.', '.#.', '###'],
    J: ['..#', '..#', '..#', '#.#', '.#.'], K: ['#.#', '#.#', '##.', '#.#', '#.#'], L: ['#..', '#..', '#..', '#..', '###'],
    M: ['#.#', '###', '###', '#.#', '#.#'], N: ['##.', '#.#', '#.#', '#.#', '#.#'], O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
    P: ['##.', '#.#', '##.', '#..', '#..'], Q: ['.#.', '#.#', '#.#', '##.', '.##'], R: ['##.', '#.#', '##.', '#.#', '#.#'],
    S: ['.##', '#..', '.#.', '..#', '##.'], T: ['###', '.#.', '.#.', '.#.', '.#.'], U: ['#.#', '#.#', '#.#', '#.#', '###'],
    V: ['#.#', '#.#', '#.#', '#.#', '.#.'], W: ['#.#', '#.#', '###', '###', '#.#'], X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
    Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], Z: ['###', '..#', '.#.', '#..', '###'],
    0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'], 2: ['##.', '..#', '.#.', '#..', '###'],
    3: ['##.', '..#', '.#.', '..#', '##.'], 4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '##.', '..#', '##.'],
    6: ['.##', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'], 8: ['###', '#.#', '###', '#.#', '###'],
    9: ['###', '#.#', '###', '..#', '##.']
  };
  const GLYPH = {};
  Object.keys(FONT).forEach((k) => { GLYPH[k] = bitmap(FONT[k], ON); });
  function glyphsOf(text) {
    const s = String(text || '').toUpperCase();
    if (!s || s.length > 8) return null;
    const out = [];
    for (let i = 0; i < s.length; i++) { const g = GLYPH[s.charAt(i)]; if (!g) return null; out.push(g); }
    return out;
  }
  function drawText(gs, x, y, c) {
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      for (let k = 0; k < g.b.length; k++) if (g.b[k]) put(x + 4 * i + k % g.w, y + ((k / g.w) | 0), c);
    }
  }
  // The name in the middle keeps the landing's M, so it matches the landing pixel for pixel. That M is too close to
  // the H in coin symbols, which is why the font above has a heavier one.
  const LANDING_M = bitmap(['#.#', '###', '#.#', '#.#', '#.#'], ON);
  const CMPG = glyphsOf('COMPOUND').map((g, i) => (i === 2 ? LANDING_M : g));

  /* ------------------------------------------------------------------ sizes */
  // The nucleus is the SOL in the curve or pool: one size per doubling, seven hand-drawn sizes. A real coin graduates
  // at about size 5. Test coins on devnet graduate far smaller, so the devnet scale starts 64 times lower.
  const BASE = { mainnet: 8, devnet: 0.125 };
  function sizeOf(sol, state) {
    const b = BASE[cluster] || BASE.devnet;
    let rn = !(sol >= b) ? 1 : 2 + Math.floor(Math.log2(sol / b) + 1e-9);
    rn = Math.max(1, Math.min(state === 'graduated' ? 7 : 5, rn));
    return state === 'graduated' ? Math.max(2, rn) : rn;
  }
  const ringR = (rn) => rn + 2;                     // 4 to 9
  const gaugeR = (rn) => Math.max(5, rn + 3);       // 5 to 8; its dots reach one pixel further
  const KDOT = 10, CDA0 = [], CDA1 = [];
  for (let k = 0; k < KDOT; k++) { CDA0[k] = (-135 + 30 * k) * DEG; CDA1[k] = (-180 + (k + 0.5) * 360 / KDOT) * DEG; }
  // A dot lights once its tenth of the curve is full, within 0.001% of the curve, so the drawing shows no more
  // progress than there is.
  function litOf(c) {
    if (c.state === 'graduated' || c.progress >= 1) return KDOT;
    if (!(c.progress > 0)) return 0;
    return Math.min(KDOT - 1, Math.floor(c.progress * KDOT + 1e-4));
  }

  /* ------------------------------------------------------------------ layouts and their sites */
  // WIDE for a stage wider than tall (desktop, tablets, landscape), SQUARE for phones. The centre sits a little high,
  // with its name under it; nothing bonds from below the name. Sites come from a seeded search and were checked by
  // hand: a bond site takes a ring up to radius 9 (reserve 10), a float site a gauge up to radius 8 (reserve 9), at
  // least 4 px apart, and every bond site's straight line to the centre keeps 2.5 px clear of every other site.
  const MCR = 7, MCD = MCR * MCR + MCR / 2, RB = 10, RF = 9;
  const LAYOUTS = {
    wide: {
      w: 192, h: 128, cx: 94, cy: 58,
      bond: [[99, 28], [123, 74], [60, 46], [74, 21], [126, 20], [42, 64], [153, 50], [44, 16], [154, 16], [23, 94], [176, 66], [179, 25]],
      float: [[125, 97], [57, 103], [152, 77], [18, 70], [104, 107], [80, 102], [137, 116], [17, 48], [38, 116], [166, 105], [20, 12], [14, 116]]
    },
    square: {
      w: 128, h: 128, cx: 64, cy: 58,
      bond: [[52, 34], [83, 34], [33, 55], [98, 77], [68, 13], [24, 82], [113, 58], [112, 34], [14, 26]],
      float: [[60, 92], [35, 14], [97, 15], [69, 113], [39, 108], [95, 106], [115, 93], [15, 115], [115, 116]]
    }
  };
  Object.keys(LAYOUTS).forEach((name) => {
    const l = LAYOUTS[name];
    l.name = name; l.nb = l.bond.length; l.nf = l.float.length;
    l.sites = l.bond.map((p) => ({ x: p[0], y: p[1], bond: true })).concat(l.float.map((p) => ({ x: p[0], y: p[1], bond: false })));
    l.bondIds = l.bond.map((p, i) => i);
    l.floatIds = l.float.map((p, i) => l.nb + i);
    l.label = { x: l.cx - 16, y: l.cy + MCR + 5, w: 4 * CMPG.length - 1, h: 5 };
  });

  /* ------------------------------------------------------------------ placement */
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const age = (c) => (c.createdAt == null ? 0 : c.createdAt);
  const byAge = (a, b) => (age(a) - age(b)) || cmp(a.mint, b.mint);
  const byDepth = (a, b) => (b.solInPool - a.solInPool) || cmp(a.mint, b.mint);
  // A coin's own order of one family of sites: the layout's, each site nudged back by up to 2.5 places by its mint.
  function prefOrder(mint, ids, salt) {
    const r = mulberry32(hash(mint) ^ salt);
    return ids.map((id, i) => ({ id: id, k: i + 2.5 * r() })).sort((a, b) => (a.k - b.k) || (a.id - b.id)).map((o) => o.id);
  }
  // coins: every coin; prev: mint -> site from the last placement in this layout (kept while the page is open).
  function assign(coins, lay, prev) {
    const grad = coins.filter((c) => c.state === 'graduated').sort(byDepth).slice(0, lay.nb);
    const curve = coins.filter((c) => c.state !== 'graduated').sort(byDepth).slice(0, lay.nf + lay.nb - grad.length);
    const owner = new Array(lay.nb + lay.nf).fill(null), pos = new Map(), isGrad = new Set(grad.map((c) => c.mint));
    const take = (c, id) => { owner[id] = c.mint; pos.set(c.mint, id); };
    grad.concat(curve).sort(byAge).forEach((c) => {
      const p = prev ? prev.get(c.mint) : undefined;
      if (p !== undefined && p < owner.length && owner[p] === null && (!isGrad.has(c.mint) || p < lay.nb)) take(c, p);
    });
    grad.slice().sort(byAge).forEach((c) => {
      if (pos.has(c.mint)) return;
      const order = prefOrder(c.mint, lay.bondIds, 0x0b0b);
      let id = order.find((i) => owner[i] === null);
      if (id === undefined) {                          // every bond site is held: one held by a coin on its curve makes way
        id = order.find((i) => !isGrad.has(owner[i]));
        pos.delete(owner[id]);
      }
      take(c, id);
    });
    // a float site that a coin is leaving as it graduates stays empty until the next read, so nothing is drawn on
    // top of the coin while its gauge closes there
    const hold = new Set();
    grad.forEach((c) => { const p = prev ? prev.get(c.mint) : undefined; if (p !== undefined && p >= lay.nb) hold.add(p); });
    curve.slice().sort(byAge).forEach((c) => {
      if (pos.has(c.mint)) return;
      const fl = prefOrder(c.mint, lay.floatIds, 0xf10a), bo = prefOrder(c.mint, lay.bondIds, 0xb0f1);
      let id = fl.find((i) => owner[i] === null && !hold.has(i));
      if (id === undefined) id = bo.find((i) => owner[i] === null);
      if (id === undefined) id = fl.find((i) => owner[i] === null);
      take(c, id);
    });
    return { shown: grad.concat(curve).sort(byDepth), pos: pos };
  }

  /* ------------------------------------------------------------------ bonds */
  // An 8-connected line, both ends included.
  function bres(x0, y0, x1, y1) {
    const xs = [], ys = [], dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) {
      xs.push(x0); ys.push(y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
    return { n: xs.length, x: xs, y: ys };
  }
  // The pixels of a bond from a ring of radius rr at (x, y) to the centre's edge, from the atom's side.
  const bondCache = new Map();
  function bondPath(x, y, rr) {
    const key = L.name + ':' + x + ':' + y + ':' + rr;
    let b = bondCache.get(key);
    if (b) return b;
    const cx = L.cx, cy = L.cy;
    const p = bres(x - (cx < x ? 1 : 0), y - (cy < y ? 1 : 0), cx - (x < cx ? 1 : 0), cy - (y < cy ? 1 : 0));
    const xs = [], ys = [];
    for (let k = 0; k < p.n; k++) {
      const ax = p.x[k] + 0.5 - x, ay = p.y[k] + 0.5 - y, ex = p.x[k] + 0.5 - cx, ey = p.y[k] + 0.5 - cy;
      if (Math.sqrt(ax * ax + ay * ay) <= rr - 0.4) continue;    // up to just under the ring, which is drawn over it
      if (ex * ex + ey * ey < MCD) break;
      xs.push(p.x[k]); ys.push(p.y[k]);
    }
    b = { n: xs.length, x: xs, y: ys };
    bondCache.set(key, b);
    return b;
  }

  /* ------------------------------------------------------------------ state */
  let L = null, mol = null, img = null, outPx = null;
  let cluster = 'devnet';
  let data = null;                 // the last good response
  let byMint = new Map();          // mint -> coin, from the last good response
  let everSeen = new Set();        // every mint seen since the page opened
  let place = { shown: [], pos: new Map() };
  let prevSites = new Map();
  const vis = new Map();           // mint -> what is drawn for a shown coin
  let selected = null;             // a mint, or '@centre', or null
  let sortBy = 'deep';
  let failed = false;
  let lastFetch = 0, lastOk = 0, timer = 0, inflight = false;
  const rmq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(rmq && rmq.matches);

  // Graduation in miniature, in ticks: the gauge's dots close into a ring and the ring shows white. If the coin sat on
  // a float site it leaves it as one white pixel and shows, white again, at its bond site (a jump, so it never passes
  // over another atom or the centre). Then its bond draws on, two pixels a tick.
  const GC = 10, GR = 2, GJ = 2;

  // Each coin's site is also remembered in this browser, so a reload starts from the same places. A convenience only:
  // without it (private window, blocked storage) the placement is the same function of the coins, from scratch.
  const STORE = 'compound:coins:sites:v2:';
  function loadSites(name) {
    const m = new Map();
    try {
      const o = JSON.parse(window.localStorage.getItem(STORE + name) || '{}');
      Object.keys(o).forEach((k) => { if (B58.test(k) && Number.isInteger(o[k]) && o[k] >= 0 && o[k] < 64) m.set(k, o[k]); });
    } catch (err) { /* no storage: start from scratch */ }
    return m;
  }
  function saveSites(name, pos) {
    try {
      const o = {};
      pos.forEach((id, k) => { o[k] = id; });
      window.localStorage.setItem(STORE + name, JSON.stringify(o));
    } catch (err) { /* no storage */ }
  }

  function setLayout(name) {
    L = LAYOUTS[name];
    canvas.width = L.w; canvas.height = L.h;
    mol = surface(L.w, L.h);
    img = ctx.createImageData(L.w, L.h);
    outPx = new Uint32Array(img.data.buffer);
    prevSites = loadSites(name);
    vis.clear();
    if (data) layoutCoins(true);
  }

  function drawnR(v) {
    if (v.gr && v.gr.ph === 0) return gaugeR(v.rn) + 1;
    return v.state === 'graduated' ? ringR(v.rn) : gaugeR(v.rn) + 1;
  }

  // Place the coins and bring what is drawn up to date. quiet: the first drawing, a new layout, or reduced motion.
  function layoutCoins(quiet) {
    place = assign(data.coins, L, prevSites);
    prevSites = new Map(place.pos);
    saveSites(L.name, place.pos);
    const keep = new Set();
    place.shown.forEach((c) => {
      keep.add(c.mint);
      const s = L.sites[place.pos.get(c.mint)];
      const rnT = sizeOf(c.solInPool, c.state), litT = litOf(c);
      let v = vis.get(c.mint);
      if (!v || quiet || reduced) {
        const fresh = !v;
        v = {
          mint: c.mint, x: s.x, y: s.y, dx: s.x, dy: s.y, state: c.state, rn: rnT, rnT: rnT, lit: litT, flash: 0,
          dotFrom: -1, dotT: 0, gr: null, bond: c.state === 'graduated' ? Infinity : -1, growT: 0, sol: c.solInPool
        };
        if (fresh && !quiet && !reduced && !everSeen.has(c.mint)) v.flash = 4;   // a coin launched since the last read
        vis.set(c.mint, v);
        return;
      }
      const moved = v.x !== s.x || v.y !== s.y;
      v.x = s.x; v.y = s.y;
      if (c.state === 'graduated' && v.state !== 'graduated' && !v.gr) {
        v.gr = { ph: 0, t: 0 };
        v.rnT = rnT; v.lit = KDOT; v.dotFrom = -1;
      } else if (v.gr) {
        v.rnT = rnT;
      } else {
        if (moved) { v.dx = s.x; v.dy = s.y; }                 // a coin made way: it is redrawn in its new place
        if (c.state !== v.state) { v.state = c.state; v.bond = c.state === 'graduated' ? Infinity : -1; v.rn = rnT; }
        if (rnT < v.rn) v.rn = rnT;
        v.rnT = rnT;
        if (litT > v.lit) { v.dotFrom = v.lit; v.dotT = 3; }
        v.lit = litT;
        if (c.solInPool > v.sol * (1 + 1e-9) + 1e-12 && v.rn === v.rnT) v.flash = Math.max(v.flash, 3);
      }
      v.sol = c.solInPool;
    });
    Array.from(vis.keys()).forEach((m) => { if (!keep.has(m)) vis.delete(m); });
  }

  /* ------------------------------------------------------------------ ticks */
  function busy() {
    for (const v of vis.values()) if (v.flash || v.dotT || v.gr || v.rn < v.rnT) return true;
    return false;
  }
  function tick() {
    for (const v of vis.values()) {
      if (v.flash) v.flash--;
      if (v.dotT && !--v.dotT) v.dotFrom = -1;
      if (v.gr) { stepGrad(v); continue; }
      if (v.rn < v.rnT) {                              // grow one drawn size at a time, each with a short flash
        if (v.growT) v.growT--;
        else { v.rn++; v.flash = 2; v.growT = 3; }
      }
    }
  }
  function stepGrad(v) {
    const g = v.gr;
    g.t++;
    if (g.ph === 0) {
      if (g.t >= GC) { g.ph = 1; g.t = 0; v.state = 'graduated'; v.rn = v.rnT; }
    } else if (g.ph === 1) {
      if (g.t >= GR) {
        g.t = 0;
        if (v.dx !== v.x || v.dy !== v.y) g.ph = 2;
        else { g.ph = 3; v.bond = 0; }
      }
    } else if (g.ph === 2) {
      if (g.t >= GJ) { g.ph = 1; g.t = 0; v.dx = v.x; v.dy = v.y; }
    } else {
      v.bond += 2;
      if (v.bond >= bondPath(v.x, v.y, ringR(v.rn)).n) { v.bond = Infinity; v.gr = null; }
    }
  }

  /* ------------------------------------------------------------------ drawing */
  function drawCentre(cx, cy) {
    for (let dy = -MCR; dy < MCR; dy++) for (let dx = -MCR; dx < MCR; dx++) {
      const X = dx + 0.5, Y = dy + 0.5;
      if (X * X + Y * Y < MCD) put(cx + dx, cy + dy, 3);
    }
    put(cx - 3, cy - 4, 4); put(cx - 4, cy - 3, 4); put(cx - 3, cy - 3, 4);
  }
  // cc 0 to 1: the gauge's dots move in and close, as on the landing; from is the first newly lit dot (it flashes)
  function drawCurve(x, y, rn, lit, cc, r1, white, from) {
    const r0 = gaugeR(rn), rad = r0 - (r0 - r1) * cc;
    coinNucleus(x, y, rn, white);
    for (let k = 0; k < KDOT; k++) {
      const a = CDA0[k] + (CDA1[k] - CDA0[k]) * cc;
      let col = 6;
      if (k < lit) col = k === lit - 1 ? 4 : 1;
      if (from >= 0 && k >= from && k < lit) col = 4;
      put(Math.floor(x + rad * Math.sin(a)), Math.floor(y - rad * Math.cos(a)), col);
    }
  }
  function drawAtom(v) {
    const white = v.flash > 0;
    if (v.gr && v.gr.ph === 0) {
      drawCurve(v.dx, v.dy, v.rn, KDOT, v.gr.t / GC, ringR(v.rnT), false, -1);
    } else if (v.gr && v.gr.ph === 2) {
      rect2(v.dx - 1, v.dy - 1, 4);
    } else if (v.state === 'graduated') {
      coinNucleus(v.dx, v.dy, v.rn, white);
      ringAt(v.dx, v.dy, ringR(v.rn), v.gr && v.gr.ph === 1 ? 4 : 1);
    } else {
      drawCurve(v.dx, v.dy, v.rn, v.lit, 0, 0, white, v.dotT ? v.dotFrom : -1);
    }
  }
  function rect2(x, y, c) { put(x, y, c); put(x + 1, y, c); put(x, y + 1, c); put(x + 1, y + 1, c); }
  function drawBond(v) {
    if (v.bond < 0) return;
    const b = bondPath(v.x, v.y, ringR(v.rn)), n = Math.min(b.n, v.bond);
    for (let k = 0; k < n; k++) put(b.x[k], b.y[k], 6);
    if (n < b.n && n > 0) put(b.x[n - 1], b.y[n - 1], 4);
  }
  // Free: on the buffer, two clear pixels above and below and three to the sides (so a label never reads as part
  // of its neighbour's), well away from the centre's name, and outside every other atom's disc.
  function rectFree(x, y, w, h, self) {
    if (x < 1 || y < 1 || x + w > S.w - 1 || y + h > S.h - 1) return false;
    for (let yy = y - 2; yy <= y + h + 1; yy++) for (let xx = x - 3; xx <= x + w + 2; xx++) if (get(xx, yy) > 0) return false;
    const lb = L.label;
    if (S === mol && x < lb.x + lb.w + 4 && x + w > lb.x - 4 && y < lb.y + lb.h + 4 && y + h > lb.y - 4) return false;
    // the gaps between a gauge's dots are not free: keep clear of every other atom's disc
    for (const v of vis.values()) {
      if (v === self) continue;
      const r = drawnR(v) + 1, nx = Math.max(x, Math.min(v.dx, x + w)), ny = Math.max(y, Math.min(v.dy, y + h));
      if ((nx - v.dx) * (nx - v.dx) + (ny - v.dy) * (ny - v.dy) < r * r) return false;
    }
    return true;
  }
  // The symbol in the buffer's own letters: under its atom, else to its right. Never over it or to its left, where it
  // would read as the label of the neighbour there. Nowhere free: it shows only when the coin is selected.
  function labelSpot(v, gs) {
    const w = 4 * gs.length - 1, r = drawnR(v), x = Math.round(v.dx - w / 2);
    if (rectFree(x, v.dy + r + 4, w, 5, v)) return { x: x, y: v.dy + r + 4 };
    if (rectFree(v.dx + r + 4, v.dy - 3, w, 5, v)) return { x: v.dx + r + 4, y: v.dy - 3 };
    return null;
  }
  function drawFrame(cx, cy, r) {
    const h = r + 2, x0 = cx - h - 1, x1 = cx + h, y0 = cy - h - 1, y1 = cy + h;
    for (let x = x0; x <= x1; x++) { if (get(x, y0) === 0) put(x, y0, 1); if (get(x, y1) === 0) put(x, y1, 1); }
    for (let y = y0 + 1; y < y1; y++) { if (get(x0, y) === 0) put(x0, y, 1); if (get(x1, y) === 0) put(x1, y, 1); }
  }

  function render() {
    if (!L) return;
    S = mol; S.b.fill(0);
    for (const v of vis.values()) if (v.state === 'graduated' || v.gr) drawBond(v);
    drawCentre(L.cx, L.cy);
    drawText(CMPG, L.label.x, L.label.y, 3);
    const order = place.shown.map((c) => vis.get(c.mint)).filter(Boolean);
    order.slice().reverse().forEach(drawAtom);                 // deepest last, so on top while one moves past
    let selSpot = null;
    order.forEach((v) => {
      const c = byMint.get(v.mint), gs = c && glyphsOf(c.symbol);
      v.lab = null;
      if (!gs || (v.gr && v.gr.ph < 3)) return;
      const spot = labelSpot(v, gs);
      v.lab = spot ? { x: spot.x, y: spot.y, w: 4 * gs.length - 1 } : null;
      if (v.mint === selected) { selSpot = spot; return; }
      if (spot) drawText(gs, spot.x, spot.y, 5);
    });
    if (selected === '@centre') drawFrame(L.cx, L.cy, MCR);
    else if (selected && vis.has(selected)) {
      const v = vis.get(selected), c = byMint.get(selected), gs = c && glyphsOf(c.symbol);
      if (gs && !(v.gr && v.gr.ph < 3)) {
        let spot = selSpot;
        if (!spot) {                                            // shown only now: cleared out under it, kept on the buffer
          const w = 4 * gs.length - 1, r = drawnR(v);
          let y = v.dy + r + 4;
          if (y + 6 > S.h) y = v.dy - r - 9;
          spot = { x: Math.max(1, Math.min(S.w - 1 - w, Math.round(v.dx - w / 2))), y: Math.max(1, y) };
          for (let yy = spot.y - 1; yy <= spot.y + 5; yy++) for (let xx = spot.x - 1; xx <= spot.x + w; xx++) put(xx, yy, 0);
          v.lab = { x: spot.x, y: spot.y, w: w };
        }
        drawText(gs, spot.x, spot.y, 4);
      }
      drawFrame(v.dx, v.dy, drawnR(v));
    }
    for (let i = 0; i < outPx.length; i++) outPx[i] = LUT[S.b[i]];
    ctx.putImageData(img, 0, 0);
  }

  /* ------------------------------------------------------------------ the clock: runs only while something animates */
  let raf = 0, last = -1, acc = 0;
  function frame(t) {
    raf = 0;
    if (reduced || document.hidden) { render(); return; }
    if (last < 0) last = t;
    acc += t - last; last = t;
    let ran = 0;
    while (acc >= TICK && ran < 3) { tick(); acc -= TICK; ran++; }
    if (acc >= TICK) acc %= TICK;
    render();
    if (busy()) raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (!reduced && !document.hidden && busy()) {
      if (!raf) { last = -1; acc = 0; raf = requestAnimationFrame(frame); }
    } else render();
  }
  function settleAll() {
    for (const v of vis.values()) {
      v.flash = 0; v.dotT = 0; v.dotFrom = -1; v.growT = 0; v.rn = v.rnT;
      if (v.gr) { v.gr = null; v.state = 'graduated'; v.dx = v.x; v.dy = v.y; v.bond = Infinity; }
    }
  }

  /* ------------------------------------------------------------------ sizing: whole device pixels */
  let cssW = -1, cssH = -1, sizeRaf = 0;
  function size() {
    const bw = box.clientWidth;
    if (!(bw > 0)) return;
    const name = bw >= 576 ? 'wide' : 'square';        // wide always starts at 3 css px, where square would give 4
    if (!L || L.name !== name) setLayout(name);
    const dpr = window.devicePixelRatio || 1, vh = window.innerHeight || 800;
    const maxH = Math.max(L.h * 2, vh - 140);          // never under 2 css px, as on a 320 px phone; the page scrolls
    const s = Math.max(1, Math.min(Math.floor(bw * dpr / L.w + 1e-6), Math.floor(maxH * dpr / L.h + 1e-6)));
    const w = L.w * s / dpr, h = L.h * s / dpr;
    if (w !== cssW || h !== cssH) { canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; cssW = w; cssH = h; }
    canvas.style.transform = 'none';
    const r = canvas.getBoundingClientRect();
    const fx = (Math.round(r.left * dpr) - r.left * dpr) / dpr, fy = (Math.round(r.top * dpr) - r.top * dpr) / dpr;
    canvas.style.transform = 'translate(' + (Math.round(fx * 1e4) / 1e4) + 'px,' + (Math.round(fy * 1e4) / 1e4) + 'px)';
    if (data) { renderCaption(); renderPanel(); }
    render();
  }
  function scheduleSize() { if (!sizeRaf) sizeRaf = requestAnimationFrame(() => { sizeRaf = 0; size(); }); }

  /* ------------------------------------------------------------------ words */
  function fmtSol(x) {
    if (x == null || !isFinite(x)) return 'unknown';
    if (x === 0) return '0';
    if (x < 0.0001) return 'under 0.0001';
    if (x >= 999.5) return Math.round(x).toLocaleString('en-US');
    return x.toPrecision(3);
  }
  // A floor is a lower bound: rounded down, so it never shows more than the chain holds.
  function fmtDown(x) {
    if (x == null || !isFinite(x)) return 'unknown';
    if (x === 0) return '0';
    if (x < 0.0001) return 'under 0.0001';
    const d = 2 - Math.floor(Math.log10(x)), p = Math.pow(10, d);
    return d > 0 ? (Math.floor(x * p + 1e-9) / p).toFixed(d) : Math.floor(x).toLocaleString('en-US');
  }
  // The list's column: the same decimals all the way down, so the digits line up.
  function fmtCol(x) {
    return x >= 1000 ? Math.round(x).toLocaleString('en-US') : x >= 0.001 ? x.toFixed(x >= 100 ? 1 : 3) : fmtSol(x);
  }
  function fmtUsd(x) { return '$' + Math.round(x).toLocaleString('en-US'); }
  function pct(p) { return p < 0.01 ? 'under 1%' : Math.min(99, Math.round(p * 100)) + '%'; }
  function shortMint(m) { return m.slice(0, 4) + '…' + m.slice(-4); }
  function displayName(c) { return c.name || c.symbol || shortMint(c.mint); }
  function stateWords(c) {
    if (c.state === 'graduated') return 'Graduated';
    return c.progress >= 1 ? 'Curve full, waiting to graduate' : 'On its curve, ' + pct(c.progress) + ' of the way';
  }
  function stateCol(c) { return c.state === 'graduated' ? 'Graduated' : c.progress >= 1 ? 'Curve full' : pct(c.progress) + ' of its curve'; }
  function solWords(c) { return fmtSol(c.solInPool) + ' SOL in its ' + (c.state === 'graduated' ? 'pool' : 'curve'); }
  function hhmm(sec) {
    const d = new Date(sec * 1000);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
  function show(el, on) { if (el && el.hidden === on) el.hidden = !on; }

  function statusLine() {
    const coins = data.coins, n = coins.length;
    if (!n) return 'No coin has launched on Compound yet.';
    const g = coins.filter((c) => c.state === 'graduated').length, k = n - g, test = cluster === 'devnet';
    const head = n + (test ? ' test coin' : ' coin') + (n === 1 ? '' : 's') + (test ? ' on Solana devnet' : ' on Solana');
    if (n === 1) return head + (g ? '. It has graduated.' : '. It is on its curve.');
    if (!g) return head + (n === 2 ? ', both on their curve.' : ', all on their curve.');
    if (!k) return head + (n === 2 ? ', both graduated.' : ', all graduated.');
    return head + ': ' + g + ' graduated, ' + k + ' on ' + (k === 1 ? 'its' : 'their') + ' curve.';
  }
  function renderStatus() {
    const st = $('status'), note = $('note'), stale = $('stale');
    if (!data) {
      setText(st, failed ? 'Couldn’t read the coins just now. Trying again in a moment.' : 'Reading the chain...');
      show(note, false); show(stale, false);
      return;
    }
    setText(st, statusLine());
    let nt = data.note || '';
    if (!nt && cluster === 'devnet') nt = 'Devnet test coins, not real money. Most graduate at a smaller size than real ones.';
    setText(note, nt); show(note, !!nt && data.coins.length > 0);
    const when = data.updated != null ? data.updated : Math.floor(lastOk / 1000);
    setText(stale, (failed ? 'Couldn’t refresh; showing data from ' : 'Read from the chain at ') + hhmm(when) + '.');
    show(stale, true);
    show($('waiting'), !!wanted && !byMint.has(wanted) && !(data && data.token && data.token.mint === wanted) && Date.now() - openedAt < WAIT_FOR_NEW);
  }
  function renderCaption() {
    const cap = $('shown'), n = place.shown.length, m = data.coins.length;
    if (n >= m) { show(cap, false); }
    else {
      const top = data.coins.slice().sort(byDepth).slice(0, n).every((c) => place.pos.has(c.mint));
      setText(cap, top ? 'Showing the ' + n + ' deepest of ' + m + '; all are in the list below.'
        : 'Showing ' + n + ' of ' + m + ', the deepest that fit; all are in the list below.');
      show(cap, true);
    }
    const g = place.shown.filter((c) => c.state === 'graduated').length, k = n - g;
    const parts = [];
    if (g) parts.push(g + ' graduated coin' + (g === 1 ? '' : 's') + ' bonded to it');
    if (k) parts.push(k + ' coin' + (k === 1 ? '' : 's') + ' on ' + (k === 1 ? 'its' : 'their') + ' curve around it, not bonded');
    const mid = data.token && data.token.test ? 'a test stand-in for the Compound token' : 'the Compound token';
    canvas.setAttribute('aria-label', !m ? 'The Compound token alone in the middle: no coin yet.'
      : 'A molecule: ' + mid + ' in the middle, ' + parts.join(', and ') + '.');
  }

  /* ------------------------------------------------------------------ small drawings for the list and the key */
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgOf(sf) {
    const paths = {};
    for (let y = 0; y < sf.h; y++) for (let x = 0; x < sf.w; x++) {
      const c = sf.b[y * sf.w + x];
      if (c) paths[c] = (paths[c] || '') + 'M' + x + ' ' + y + 'h1v1h-1z';
    }
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + sf.w + ' ' + sf.h);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'px');
    Object.keys(paths).forEach((c) => {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', paths[c]); p.setAttribute('fill', '#' + HEX[c]);
      svg.appendChild(p);
    });
    return svg;
  }
  function miniAtom(state, lit, bondOut) {
    const keep = S, sf = surface(16, 16);
    S = sf;
    if (state === 'graduated') {
      if (bondOut) { for (let i = 0; i < 4; i++) put(13 + i, 4 - i, 6); }
      coinNucleus(8, 8, 3, false); ringAt(8, 8, 5, 1);
    } else drawCurve(8, 8, 2, lit, 0, 0, false, -1);
    S = keep;
    return svgOf(sf);
  }
  function miniCentre() {
    const keep = S, sf = surface(16, 16);
    S = sf;
    for (let dy = -5; dy < 5; dy++) for (let dx = -5; dx < 5; dx++) if (inDisc(dx, dy, 5.2)) put(8 + dx, 8 + dy, 3);
    put(6, 5, 4); put(5, 6, 4); put(6, 6, 4);
    S = keep;
    return svgOf(sf);
  }
  function fillSwatch(id, svg) { const el = $(id); if (el) { el.textContent = ''; el.appendChild(svg); } }
  fillSwatch('sw-centre', miniCentre());
  fillSwatch('sw-curve', miniAtom('curve', 6, false));
  fillSwatch('sw-grad', miniAtom('graduated', KDOT, true));

  /* ------------------------------------------------------------------ coin images */
  // Set before src, so the first request already has them. One that fails is not tried again while the page is open.
  const badImages = new Set();
  function coinImage(url) {
    const im = document.createElement('img');
    im.className = 'coin-img';
    im.alt = '';
    im.width = 32;
    im.height = 32;
    im.setAttribute('loading', 'lazy');
    im.setAttribute('referrerpolicy', 'no-referrer');
    im.addEventListener('error', () => { badImages.add(url); renderList(); renderPanel(); });
    im.setAttribute('src', url);
    return im;
  }

  /* ------------------------------------------------------------------ the list */
  const rowsEl = $('rows'), rowEls = new Map();
  function rowFor(c) {
    let r = rowEls.get(c.mint);
    if (!r) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'row'; b.setAttribute('data-mint', c.mint);
      const ico = document.createElement('span'); ico.className = 'ico';
      const who = document.createElement('span'); who.className = 'who';
      const sym = document.createElement('span'); sym.className = 'sym';
      const nm = document.createElement('span'); nm.className = 'nm';
      who.appendChild(sym); who.appendChild(nm);
      const st = document.createElement('span'); st.className = 'st';
      const sol = document.createElement('span'); sol.className = 'sol';
      b.appendChild(ico); b.appendChild(who); b.appendChild(st); b.appendChild(sol);
      b.addEventListener('click', (e) => {
        const on = selected !== c.mint;
        select(on ? c.mint : null);
        // by keyboard (a click with no pointer) on into the panel: its copy and Solscan come before the list
        if (on && e.detail === 0) $('fx-name').focus({ preventScroll: true });
      });
      li.appendChild(b);
      r = { li: li, b: b, ico: ico, sym: sym, nm: nm, st: st, sol: sol, icoKey: '' };
      rowEls.set(c.mint, r);
    }
    const pic = c.image && !badImages.has(c.image) ? c.image : '';
    const key = c.state + ':' + litOf(c) + ':' + pic;
    if (key !== r.icoKey) { r.icoKey = key; r.ico.textContent = ''; r.ico.appendChild(pic ? coinImage(pic) : miniAtom(c.state, litOf(c), false)); }
    setText(r.sym, c.symbol || shortMint(c.mint));
    setText(r.nm, c.name && c.name !== c.symbol ? c.name : '');
    setText(r.st, stateCol(c));
    setText(r.sol, fmtCol(c.solInPool) + ' SOL');
    const label = (c.symbol ? c.symbol + ', ' : '') + displayName(c) + '. ' + stateWords(c) + '. ' + solWords(c) + '.';
    if (r.b.getAttribute('aria-label') !== label) r.b.setAttribute('aria-label', label);
    const on = c.mint === selected;
    if (r.b.getAttribute('aria-pressed') !== String(on)) r.b.setAttribute('aria-pressed', String(on));
    return r;
  }
  function renderList() {
    const list = $('list');
    if (!data || !data.coins.length) { show(list, false); return; }
    show(list, true);
    setText($('list-h'), cluster === 'devnet' ? 'Every test coin' : 'Every coin');
    const coins = data.coins.slice().sort(sortBy === 'new' ? ((a, b) => (age(b) - age(a)) || cmp(a.mint, b.mint)) : byDepth);
    const live = new Set(coins.map((c) => c.mint));
    Array.from(rowEls.keys()).forEach((m) => {
      if (!live.has(m)) { const r = rowEls.get(m); if (r.li.parentNode) r.li.parentNode.removeChild(r.li); rowEls.delete(m); }
    });
    const focused = document.activeElement;
    const want = coins.map((c) => rowFor(c).li);
    const have = Array.from(rowsEl.children);
    if (want.length !== have.length || want.some((li, i) => li !== have[i])) {
      want.forEach((li) => rowsEl.appendChild(li));
      if (focused && focused !== document.activeElement && focused.focus) focused.focus();
    }
    const deep = $('sort-deep'), fresh = $('sort-new');
    if (deep) deep.setAttribute('aria-pressed', String(sortBy === 'deep'));
    if (fresh) fresh.setAttribute('aria-pressed', String(sortBy === 'new'));
  }

  /* ------------------------------------------------------------------ the token in the middle */
  const NO_TOKEN = ['key-centre-soon', 'key-grad-soon', 'fxc-fine-soon', 'fx-empty-soon'];
  const WITH_TOKEN = ['key-open', 'fxc-state', 'fxc-figures', 'fxc-wallet'];
  const WITH_TEST = ['key-centre-live', 'key-grad-live', 'fxc-fine-live'];   // the devnet stand-in's words
  const WITH_REAL = ['key-centre-real', 'fxc-fine-real', 'fxc-token'];        // the real token's, on mainnet
  function renderToken() {
    const t = data && data.token;
    NO_TOKEN.forEach((id) => show($(id), !t));
    WITH_TOKEN.forEach((id) => show($(id), !!t));
    WITH_TEST.forEach((id) => show($(id), !!t && t.test));
    WITH_REAL.forEach((id) => show($(id), !!t && !t.test));
    show($('fxc-old'), !!(t && data.tokenOld));
    if (!t) return;
    setText($('fxc-state'), (t.test ? 'Test stand-in. ' : '') + (t.state === 'graduated' ? 'Graduated' : 'On its curve') + '.');
    setText($('fxc-held-l'), (t.test ? 'test ' : '') + 'tokens the buyback wallet holds');
    setText($('fxc-burned-l'), (t.test ? 'test ' : '') + 'tokens burned');
    const tokenScan = $('fxc-token-scan');
    if (tokenScan) {
      const href = 'https://solscan.io/token/' + encodeURIComponent(t.mint) + (cluster === 'devnet' ? '?cluster=devnet' : '');
      if (tokenScan.getAttribute('href') !== href) tokenScan.setAttribute('href', href);
    }
    setText($('fxc-held'), fmtDown(t.heldTokens));
    setText($('fxc-burned'), fmtDown(t.burnedTokens));
    setText($('fxc-pot'), fmtDown(t.potSol));
    setText($('fxc-mc'), fmtDown(t.marketCapSol));
    setText($('fxc-name'), displayName(t));
    const scan = $('fxc-scan');
    if (scan) {
      const href = 'https://solscan.io/account/' + encodeURIComponent(t.wallet) + (cluster === 'devnet' ? '?cluster=devnet' : '');
      if (scan.getAttribute('href') !== href) scan.setAttribute('href', href);
    }
  }

  /* ------------------------------------------------------------------ the details panel */
  function renderPanel() {
    renderToken();
    const key = $('fx-key'), one = $('fx-coin'), mid = $('fx-centre'), none = $('fx-empty');
    // empty only with no coin and no token: the token alone still has its key and its panel
    const empty = !!data && !data.coins.length && !data.token;
    const c = selected && selected !== '@centre' ? byMint.get(selected) : null;
    show(none, empty);
    show(mid, !empty && selected === '@centre');
    show(one, !empty && !!c);
    show(key, !empty && !c && selected !== '@centre');
    if (!c) return;
    setText($('fx-name'), displayName(c));
    const picEl = $('fx-img'), pic = c.image && !badImages.has(c.image) ? c.image : '';
    if (picEl && picEl.getAttribute('data-url') !== pic) {
      picEl.setAttribute('data-url', pic);
      picEl.textContent = '';
      if (pic) picEl.appendChild(coinImage(pic));
    }
    show(picEl, !!pic);
    setText($('fx-sym'), c.symbol && c.symbol !== c.name ? c.symbol : '');
    show($('fx-sym'), !!c.symbol && c.symbol !== c.name);
    setText($('fx-state'), (cluster === 'devnet' ? 'Test coin. ' : '') + stateWords(c) + '.');
    setText($('fx-sol-l'), c.state === 'graduated' ? 'SOL in its pool' : 'SOL in its curve');
    setText($('fx-sol'), fmtSol(c.solInPool));
    setText($('fx-mc'), fmtSol(c.marketCapSol));
    setText($('fx-mc-l'), 'SOL market cap' + (cluster === 'mainnet' && c.marketCapUsd != null ? ', about ' + fmtUsd(c.marketCapUsd) : ''));
    const grad = c.state === 'graduated';
    show($('fx-floor-row'), grad); show($('fx-floor-note'), grad);
    show($('fx-grad-row'), !grad && c.graduationSol != null);
    if (!grad && c.graduationSol != null) setText($('fx-grad'), fmtSol(c.graduationSol));
    if (grad) setText($('fx-floor'), fmtDown(c.floorSol));
    setText($('fx-mint'), shortMint(c.mint));
    const mintEl = $('fx-mint');
    if (mintEl && mintEl.getAttribute('title') !== c.mint) mintEl.setAttribute('title', c.mint);
    const scan = $('fx-scan');
    if (scan) {
      const href = 'https://solscan.io/token/' + encodeURIComponent(c.mint) + (cluster === 'devnet' ? '?cluster=devnet' : '');
      if (scan.getAttribute('href') !== href) scan.setAttribute('href', href);
    }
    const off = $('fx-off');
    const drawn = place.pos.has(c.mint);
    setText(off, drawn ? '' : 'Not drawn in the molecule: only the ' + place.shown.length + ' deepest that fit are. It is in the list below.');
    show(off, !drawn);
  }

  function select(id) {
    wanted = null;
    show($('waiting'), false);
    if (id && id !== '@centre' && !byMint.has(id)) id = null;
    const changed = id !== selected;
    selected = id;
    renderPanel();
    rowEls.forEach((r, m) => r.b.setAttribute('aria-pressed', String(m === selected)));
    render();
    if (changed && id) {
      const name = id === '@centre' ? (data && data.token && data.token.test ? 'the test stand-in for Compound' : 'Compound') : displayName(byMint.get(id));
      setText($('fx-live'), 'Showing ' + name + '.');
      const fx = $('facts');
      if (fx && fx.getBoundingClientRect) {
        const r = fx.getBoundingClientRect(), vh = window.innerHeight || 0;
        if (r.top < 0 || r.top > vh - 120) fx.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
      }
    }
  }

  /* ------------------------------------------------------------------ pointer on the molecule */
  function hit(e) {
    const r = canvas.getBoundingClientRect();
    if (!L || !r.width || !r.height) return null;
    const bx = (e.clientX - r.left) / r.width * L.w, by = (e.clientY - r.top) / r.height * L.h;
    for (const v of vis.values()) if (v.lab && bx >= v.lab.x - 1 && bx <= v.lab.x + v.lab.w + 1 && by >= v.lab.y - 1 && by <= v.lab.y + 6) return v.mint;
    let best = null, bd = Infinity;
    for (const v of vis.values()) {
      const dx = bx - v.dx, dy = by - v.dy, d = Math.sqrt(dx * dx + dy * dy), reach = Math.max(drawnR(v) + 2, 11);
      if (d <= reach && d < bd) { bd = d; best = v.mint; }
    }
    if (best) return best;
    const dx = bx - L.cx, dy = by - L.cy, lb = L.label;
    if (dx * dx + dy * dy <= (MCR + 2) * (MCR + 2)) return '@centre';
    if (bx >= lb.x - 1 && bx <= lb.x + lb.w + 1 && by >= lb.y - 1 && by <= lb.y + lb.h + 1) return '@centre';
    return null;
  }
  canvas.addEventListener('click', (e) => {
    if (!data) return;
    const id = hit(e);
    if (id || selected) select(id && id !== selected ? id : null);
  });
  let cursorOn = null;
  canvas.addEventListener('mousemove', (e) => {
    const on = !!(data && hit(e));
    if (on !== cursorOn) { cursorOn = on; canvas.style.cursor = on ? 'pointer' : 'default'; }
  });
  // wallet.js runs first and marks an Escape it used to close its panel. Escape from inside the details goes back to
  // the coin's row, or from the Compound panel to the key's button, because the focused control is about to be hidden.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !selected || e.defaultPrevented) return;
    const fx = $('facts'), inside = fx && fx.contains(document.activeElement);
    const back = !inside ? null : selected === '@centre' ? $('key-open') : (rowEls.get(selected) || {}).b;
    select(null);
    if (back) back.focus();
  });

  /* ------------------------------------------------------------------ controls */
  function setSort(s) { sortBy = s; renderList(); }
  const sd = $('sort-deep'), sn = $('sort-new');
  if (sd) sd.addEventListener('click', () => setSort('deep'));
  if (sn) sn.addEventListener('click', () => setSort('new'));
  // The canvas takes a pointer only, so this is the way to the Compound panel from a keyboard. The button goes as the
  // panel opens, so focus always moves.
  const keyOpen = $('key-open');
  if (keyOpen) keyOpen.addEventListener('click', () => { select('@centre'); $('fxc-h').focus({ preventScroll: true }); });
  const copyBtn = $('fx-copy');
  let copyT = 0;
  function copied(ok) {
    if (!copyBtn) return;
    copyBtn.textContent = ok ? 'copied' : 'copy failed';
    setText($('fx-live'), ok ? 'Mint copied.' : 'Copy failed.');
    clearTimeout(copyT);
    copyT = setTimeout(() => { copyBtn.textContent = 'copy'; }, 1600);
  }
  if (copyBtn) copyBtn.addEventListener('click', () => {
    const c = selected && byMint.get(selected);
    if (!c) return;
    const fallback = () => {
      try {
        const t = document.createElement('textarea');
        t.value = c.mint; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.top = '-1000px';
        document.body.appendChild(t); t.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(t);
        copied(ok);
      } catch (err) { copied(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(c.mint).then(() => copied(true), fallback);
    else fallback();
  });

  /* ------------------------------------------------------------------ data */
  const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
  function httpsUrl(x) { return typeof x === 'string' && x.length <= 300 && /^https:\/\/[^\s"'<>]+$/.test(x) ? x : null; }
  // A coin's picture: https, or, on a local preview only, a file from this same server's /uploads, where a local run
  // keeps pictures when no image host is set up.
  function imageUrl(x) {
    const at = window.location || {};
    const file = typeof x === 'string' ? x.match(/^http:\/\/localhost:(\d+)\/uploads\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/) : null;
    return file && file[1] === String(at.port) && /^(localhost|127\.0\.0\.1)$/.test(String(at.hostname)) ? x : httpsUrl(x);
  }
  // The coin a #<mint> in the address asks for, until it has been selected once.
  function hashMint() {
    let h = '';
    try { h = decodeURIComponent(String(window.location.hash || '').slice(1)); } catch (err) { /* no address, or a bad one */ }
    return B58.test(h) ? h : null;
  }
  let wanted = hashMint();
  // The launch page links here at once, and the answer can be up to a minute old, so the line says it is coming. Capped
  // so a bad link doesn't show it for ever.
  const openedAt = Date.now(), WAIT_FOR_NEW = 120000;
  // A link to the token's own mint (the token block on every page) opens its panel in the middle.
  function selectWanted() {
    if (!wanted) return;
    if (byMint.has(wanted)) select(wanted);
    else if (data && data.token && data.token.mint === wanted && selected !== '@centre') select('@centre');
  }
  function str(x, max) { return typeof x === 'string' ? x.replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max) : ''; }
  // The token in the middle, whole or not at all: anything off drops it and the page keeps its plain words. A test
  // stand-in on devnet, or the real token on mainnet: never one on the other's cluster, because the words around it
  // say which it is.
  function cleanToken(t, where) {
    if (!t || typeof t !== 'object') return null;
    if (!((where === 'devnet' && t.test === true) || (where === 'mainnet' && t.test !== true))) return null;
    if (t.state !== 'curve' && t.state !== 'graduated') return null;
    if (![t.mint, t.pool, t.wallet].every((x) => typeof x === 'string' && B58.test(x))) return null;
    if (![t.priceSol, t.marketCapSol, t.potSol, t.heldTokens, t.burnedTokens].every((x) => num(x) != null && x >= 0)) return null;
    return {
      mint: t.mint, name: str(t.name, 64), symbol: str(t.symbol, 16), test: where === 'devnet', state: t.state,
      priceSol: t.priceSol, marketCapSol: t.marketCapSol, pool: t.pool, wallet: t.wallet,
      potSol: t.potSol, heldTokens: t.heldTokens, burnedTokens: t.burnedTokens
    };
  }
  // Takes the response apart field by field; anything off is dropped, never shown as it came.
  function clean(j) {
    if (!j || typeof j !== 'object' || !Array.isArray(j.coins)) return null;
    if (j.cluster !== 'devnet' && j.cluster !== 'mainnet') return null;
    const seen = new Set(), coins = [];
    j.coins.forEach((c) => {
      if (!c || typeof c !== 'object' || typeof c.mint !== 'string' || !B58.test(c.mint) || seen.has(c.mint)) return;
      if (c.state !== 'curve' && c.state !== 'graduated') return;
      const sol = num(c.solInPool);
      if (sol == null || sol < 0) return;
      seen.add(c.mint);
      const p = num(c.progress);
      coins.push({
        mint: c.mint, name: str(c.name, 64), symbol: str(c.symbol, 16), state: c.state, solInPool: sol,
        progress: c.state === 'graduated' ? 1 : Math.max(0, Math.min(1, p == null ? 0 : p)),
        priceSol: num(c.priceSol), marketCapSol: num(c.marketCapSol), marketCapUsd: num(c.marketCapUsd),
        floorSol: c.state === 'graduated' ? num(c.floorSol) : null,
        pool: typeof c.pool === 'string' && B58.test(c.pool) ? c.pool : '',
        config: typeof c.config === 'string' && B58.test(c.config) ? c.config : '',
        createdAt: num(c.createdAt), image: imageUrl(c.image),
        graduationSol: c.state === 'curve' && num(c.graduationSol) > 0 ? num(c.graduationSol) : null
      });
    });
    return {
      cluster: j.cluster, updated: num(j.updated), solUsd: num(j.solUsd), token: cleanToken(j.token, j.cluster),
      note: str(j.note, 240) || null, coins: coins.sort(byDepth)
    };
  }
  function apply(d) {
    const first = !data, sameCluster = d.cluster === cluster;
    if (d.cluster !== cluster) { cluster = d.cluster; bondCache.clear(); }
    d.coins.forEach((c) => { const was = byMint.get(c.mint); if (c.createdAt == null && was && was.createdAt != null) c.createdAt = was.createdAt; });
    // the token's read can fail alone, and an open page must not go back to its plain words over that; a token from
    // the other cluster is never kept, as its words would be the wrong ones
    d.tokenOld = sameCluster && !d.token && !!(data && data.token);
    if (d.tokenOld) d.token = data.token;
    data = d;
    byMint = new Map(d.coins.map((c) => [c.mint, c]));
    if (selected && selected !== '@centre' && !byMint.has(selected)) selected = null;
    if (L) layoutCoins(first);
    d.coins.forEach((c) => everSeen.add(c.mint));
    renderStatus(); renderCaption(); renderList(); renderPanel();
    selectWanted();
    if (reduced) settleAll();
    kick();
  }
  async function load() {
    clearTimeout(timer); timer = 0;
    if (inflight) return;
    inflight = true;
    lastFetch = Date.now();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const to = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT) : 0;
    try {
      const res = await fetch(API, { cache: 'no-store', headers: { accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error('status ' + res.status);
      const d = clean(await res.json());
      if (!d) throw new Error('shape');
      failed = false;
      lastOk = Date.now();
      // server instances each keep their own answer, so one can be older than what is on screen: nothing goes back
      if (data && d.updated != null && data.updated != null && d.updated < data.updated) renderStatus();
      else apply(d);
    } catch (err) {
      failed = true;
      renderStatus();
    } finally {
      clearTimeout(to);
      inflight = false;
      schedule();
    }
  }
  function schedule() {
    clearTimeout(timer); timer = 0;
    if (document.hidden) return;
    timer = setTimeout(load, Math.max(0, REFRESH - (Date.now() - lastFetch)));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timer); timer = 0; }
    else { if (!inflight) schedule(); kick(); }
  });

  /* ------------------------------------------------------------------ start */
  function onMQ(mq, fn) { if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn); }
  if (rmq) onMQ(rmq, () => { reduced = rmq.matches; if (reduced) settleAll(); kick(); });
  let dprMq = null;
  function watchDpr() {
    if (!window.matchMedia) return;
    if (dprMq && dprMq.removeEventListener) dprMq.removeEventListener('change', onDpr);
    dprMq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    onMQ(dprMq, onDpr);
  }
  function onDpr() { watchDpr(); size(); }

  size();
  if (!L) setLayout('square');
  watchDpr();
  window.addEventListener('resize', scheduleSize);
  window.addEventListener('load', scheduleSize);
  window.addEventListener('hashchange', () => { wanted = hashMint(); selectWanted(); });
  if (window.ResizeObserver) new ResizeObserver(scheduleSize).observe(box);
  renderStatus();
  render();
  load();
})();
