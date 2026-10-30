/*
 * Compound: the pixel atom.
 *
 * One 128x128 buffer of palette indices, drawn pixel by pixel (no paths, no anti-aliasing, no alpha) and
 * shown at a whole number of device pixels per buffer pixel. The nucleus is the pool and its floor.
 * The page's scroll (compound:progress, p from -1 to 5.999) scrubs one coin's life: cover, rewind, curve,
 * graduate, compound, floor, join, launch. In join the camera pulls back and the coin becomes one small atom
 * of a molecule around the Compound token; launch keeps the molecule. A fixed 30-tick clock chases the
 * targets that p sets, behind ordering gates, so jumps play back in story order.
 *
 * DOM: reads #atom and its parent's box; writes only #atom's style.width, style.height, style.transform
 * and style.cursor. Talks to page.js through window events only. Defines no globals.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('atom');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var W = 128, TICK = 1000 / 30, TAU = Math.PI * 2, DEG = Math.PI / 180, MAXN = 127;
  var COVER = 0, REWIND = 1, CURVE = 2, GRAD = 3, COMP = 4, FLOOR = 5, JOIN = 6, LAUNCH = 7;
  var now = (window.performance && performance.now) ? function () { return performance.now(); } : Date.now;

  /* ------------------------------------------------------------------ palette */
  // 0 transparent, 1 gold, 2 orange, 3 violet, 4 white, 5 muted, 6 dim, 7 line, 8 line-soft, 9 unlit
  var HEX = ['000000', 'F5BD00', 'F54B00', '6E45FF', 'F5F5FF', '9595B2', '6C6C89', '2C2E49', '242540', '2A2A3C'];
  var LITTLE = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
  var LUT = new Uint32Array(10);
  for (var li = 1; li < 10; li++) {
    var cr = parseInt(HEX[li].substr(0, 2), 16), cg = parseInt(HEX[li].substr(2, 2), 16), cb = parseInt(HEX[li].substr(4, 2), 16);
    LUT[li] = LITTLE ? (((255 << 24) | (cb << 16) | (cg << 8) | cr) >>> 0) : (((cr << 24) | (cg << 16) | (cb << 8) | 255) >>> 0);
  }

  var buf = new Uint8Array(W * W);
  var img = ctx.createImageData(W, W);
  var out = new Uint32Array(img.data.buffer);
  ctx.imageSmoothingEnabled = false;

  function mulberry32(a) {
    return function () {
      var t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var rnd = mulberry32(2);

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function f85(u) { return Math.min(1, u / 0.85); }
  function angDist(a, b) { var d = Math.abs(a - b) % TAU; return d > Math.PI ? TAU - d : d; }
  function norm(a) { a %= TAU; return a < 0 ? a + TAU : a; }
  function sgn(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

  /* ------------------------------------------------------------------ pixels */
  function put(x, y, c) {
    if (x >= 0 && x < W && y >= 0 && y < W) buf[(y << 7) + x] = c;
  }
  function rect(x, y, w, h, c) {
    for (var yy = y; yy < y + h; yy++) for (var xx = x; xx < x + w; xx++) put(xx, yy, c);
  }

  /* ------------------------------------------------------------------ rasteriser */
  // An ellipse (a, b, tilt phi) centred on O = (64, 64), as a clean 8-connected 1px line.
  function raster(a, b, phi) {
    var N = Math.ceil(TAU * Math.max(a, b) * 4);
    var A = a - 0.5, B = b - 0.5, cp = Math.cos(phi), sp = Math.sin(phi);
    var xs = [], ys = [], ts = [], k, L;
    for (k = 0; k < N; k++) {
      var t = TAU * k / N, ct = Math.cos(t), st = Math.sin(t);
      var px = Math.floor(64 + A * ct * cp - B * st * sp), py = Math.floor(64 + A * ct * sp + B * st * cp);
      L = xs.length;
      if (L && xs[L - 1] === px && ys[L - 1] === py) continue;
      xs.push(px); ys.push(py); ts.push(t);
    }
    while (xs.length > 1 && xs[xs.length - 1] === xs[0] && ys[ys.length - 1] === ys[0]) { xs.pop(); ys.pop(); ts.pop(); }
    var changed = true;
    while (changed) {
      changed = false;
      for (k = 0; k < xs.length && xs.length > 3; k++) {
        L = xs.length;
        var p = (k - 1 + L) % L, q = (k + 1) % L;
        if (Math.abs(xs[p] - xs[q]) === 1 && Math.abs(ys[p] - ys[q]) === 1) {
          xs.splice(k, 1); ys.splice(k, 1); ts.splice(k, 1); changed = true; k--;
        }
      }
    }
    L = xs.length;
    var r = { n: L, x: new Int16Array(L), y: new Int16Array(L), front: new Uint8Array(L), d2: new Float32Array(L) };
    for (k = 0; k < L; k++) {
      r.x[k] = xs[k]; r.y[k] = ys[k];
      r.front[k] = Math.sin(ts[k]) > 0 ? 1 : 0;
      var dx = xs[k] + 0.5 - 64, dy = ys[k] + 0.5 - 64;
      r.d2[k] = dx * dx + dy * dy;
    }
    return r;
  }
  // A circle, reordered clockwise from 12 o'clock.
  function ringRaster(rad) {
    var c = raster(rad, rad, 0), L = c.n, ord = [], k;
    for (k = 0; k < L; k++) ord.push({ a: norm(Math.atan2(c.x[k] + 0.5 - 64, -(c.y[k] + 0.5 - 64))), x: c.x[k], y: c.y[k] });
    ord.sort(function (p, q) { return p.a - q.a; });
    var r = { n: L, x: new Int16Array(L), y: new Int16Array(L) };
    for (k = 0; k < L; k++) { r.x[k] = ord[k].x; r.y[k] = ord[k].y; }
    return r;
  }
  var RINGS = [];
  for (var rr = 2; rr <= 32; rr++) RINGS[rr] = ringRaster(rr);

  // Three unequal orbits (not three copies 60 degrees apart), so the drawing is its own and not the stock atom.
  var ORBP = [[58, 15, 18], [50, 22, 84], [40, 30, 141]];   // a, b, tilt in degrees
  var ORB = [raster(58, 15, 18 * DEG), raster(50, 22, 84 * DEG), raster(40, 30, 141 * DEG)];
  var OLEN = [ORB[0].n, ORB[1].n, ORB[2].n];
  // The same orbits seen from further away, for the zoom's middle drawings (cached per scale).
  var ZORB = {};
  function zorb(k, s) { var key = k + ':' + s.toFixed(3); return ZORB[key] || (ZORB[key] = raster(ORBP[k][0] * s, ORBP[k][1] * s, ORBP[k][2] * DEG)); }
  var SPEED = [1, 1, 1];                       // whole pixels per tick: no hitches, no skips
  var SETTLED = [0, Math.floor(OLEN[1] / 3), Math.floor(2 * OLEN[2] / 3)];
  var DOTR = RINGS[12], DOTLEN = DOTR.n;      // the floor at graduation (19 nucleons)

  /* ------------------------------------------------------------------ nucleus lattice */
  var cand = [];
  for (var lj = -10; lj <= 10; lj++) {
    for (var lk = -10; lk <= 10; lk++) {
      var LX = 64 + 4 * lk + 2 * (lj & 1), LY = 64 + 3 * lj, ldx = LX - 64, ldy = LY - 64;
      cand.push({ x: LX, y: LY, d2: ldx * ldx + ldy * ldy, a: norm(Math.atan2(ldx, -ldy)) });
    }
  }
  cand.sort(function (p, q) { return (p.d2 - q.d2) || (p.a - q.a); });
  var SX = new Int16Array(MAXN), SY = new Int16Array(MAXN), SD2 = new Int32Array(MAXN), SA = new Float64Array(MAXN);
  var SHELL = new Uint8Array(MAXN), SH0 = [], SH1 = [];
  for (var sk = 0; sk < MAXN; sk++) {
    SX[sk] = cand[sk].x; SY[sk] = cand[sk].y; SD2[sk] = cand[sk].d2; SA[sk] = cand[sk].a;
    if (sk === 0 || SD2[sk] !== SD2[sk - 1]) { SH0.push(sk); SH1.push(sk + 1); } else SH1[SH1.length - 1] = sk + 1;
    SHELL[sk] = SH0.length - 1;
  }
  var NSH = SH0.length;
  var ORDER = new Uint8Array(MAXN);            // draw order: by Y, then X
  (function () {
    var o = [];
    for (var i = 0; i < MAXN; i++) o.push(i);
    o.sort(function (p, q) { return (SY[p] - SY[q]) || (SX[p] - SX[q]); });
    for (i = 0; i < MAXN; i++) ORDER[i] = o[i];
  })();

  /* ------------------------------------------------------------------ bitmaps */
  function bitmap(rows, map) {
    var h = rows.length, w = rows[0].length, b = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) b[y * w + x] = map[rows[y].charAt(x)] || 0;
    return { w: w, h: h, b: b };
  }
  var SPR = { G: 1, O: 2, W: 4 };
  // The cluster is lit as one sphere from the top left, in flat steps: lit, flat and dark protons.
  var PROTON = bitmap(['.GG.', 'GWGG', 'GGGO', '.GO.'], SPR);
  var PROTON_FLAT = bitmap(['.GG.', 'GGGG', 'GGGO', '.GO.'], SPR);
  var PROTON_DARK = bitmap(['.GG.', 'GGGO', 'GGOO', '.OO.'], SPR);
  var NEUTRON = bitmap(['.OO.', 'OGOO', 'OOOO', '.OO.'], SPR);
  // Neutrons by a 3-colouring of the lattice: no two touch, none bunch into a cap.
  var NEU = new Uint8Array(MAXN);
  for (var nk = 0; nk < MAXN; nk++) NEU[nk] = (((((SX[nk] - 64) / 2 - (SY[nk] - 64)) / 2) % 3 + 3) % 3 === 0) ? 1 : 0;
  function litSide(k) { return (SX[k] - 64) + (SY[k] - 64) < -0.5 * rN; }
  function darkSide(k) { return (SX[k] - 64) + (SY[k] - 64) > 0.5 * rN; }

  var ON = { '#': 1 };
  var GLYPH = {
    A: bitmap(['.#.', '#.#', '###', '#.#', '#.#'], ON),
    B: bitmap(['##.', '#.#', '##.', '#.#', '##.'], ON),
    C: bitmap(['.##', '#..', '#..', '#..', '.##'], ON),
    D: bitmap(['##.', '#.#', '#.#', '#.#', '##.'], ON),
    E: bitmap(['###', '#..', '##.', '#..', '###'], ON),
    K: bitmap(['#.#', '#.#', '##.', '#.#', '#.#'], ON),
    M: bitmap(['#.#', '###', '#.#', '#.#', '#.#'], ON),
    N: bitmap(['##.', '#.#', '#.#', '#.#', '#.#'], ON),
    O: bitmap(['.#.', '#.#', '#.#', '#.#', '.#.'], ON),
    P: bitmap(['##.', '#.#', '##.', '#..', '#..'], ON),
    R: bitmap(['##.', '#.#', '##.', '#.#', '#.#'], ON),
    T: bitmap(['###', '.#.', '.#.', '.#.', '.#.'], ON),
    U: bitmap(['#.#', '#.#', '#.#', '#.#', '###'], ON),
    Y: bitmap(['#.#', '#.#', '.#.', '.#.', '.#.'], ON),
    '2': bitmap(['##.', '..#', '.#.', '#..', '###'], ON),
    '5': bitmap(['###', '#..', '##.', '..#', '##.'], ON),
    '$': bitmap(['.#.', '.##', '#..', '.#.', '..#', '##.', '.#.'], ON)
  };
  function glyphs(s) { var a = []; for (var i = 0; i < s.length; i++) a.push(GLYPH[s.charAt(i)]); return a; }
  var BUYG = glyphs('BUYBACK'), METG = glyphs('METEORA'), CMPG = glyphs('COMPOUND');
  var GTG = glyphs('$5K$25K'), GTX = [31, 35, 39, 85, 89, 93, 97];
  function drawGlyph(g, x, y, c) {
    var b = g.b, w = g.w;
    for (var i = 0; i < b.length; i++) if (b[i]) put(x + i % w, y + ((i / w) | 0), c);
  }

  /* ------------------------------------------------------------------ gauge (the bonding curve) */
  var GA0 = new Float64Array(28), GA1 = new Float64Array(28);
  for (var gk = 0; gk < 28; gk++) {
    GA0[gk] = (-135 + 10 * gk) * DEG;
    GA1[gk] = (-180 + (gk + 0.5) * 360 / 28) * DEG;
  }

  /* ------------------------------------------------------------------ the molecule (join and launch) */
  // After the floor the camera pulls back: our coin becomes one small atom of a molecule. In the middle is the
  // Compound token, violet and without gold (its own pool does not compound). Only graduated coins are bonded,
  // and what runs along a bond is the 16% of that pool's fee that buys the Compound token. A bond carries
  // nothing else: coins share no liquidity. Corner-point coordinates, like O.
  var MCX = 64, MCY = 60, MCR = 7, MCD = MCR * MCR + MCR / 2;   // the centre disc: a little fuller than r², so it is round
  var SATS = [
    // x, y: its place; rr: ring radius when it arrives (ours follows n); max: the largest it grows to; kind 0
    // graduated, 1 still on its curve, 2 on its curve and graduates in launch; ex, ey: where it comes in from,
    // off the buffer; a: the J at which it sets off; rn, lit: nucleus radius and lit dots while on its curve.
    // Unequal angles, bond lengths and sizes, and nothing bonded below the label, so it reads as a drawing.
    { x: 33, y: 74, rr: 7, max: 9, kind: 0, ex: 33, ey: 74, a: 0 },          // 0: ours, brought here by the zoom
    { x: 80, y: 30, rr: 6, max: 7, kind: 0, ex: 100, ey: -12, a: 15 },
    { x: 39, y: 45, rr: 5, max: 7, kind: 0, ex: -12, ey: 38, a: 18 },
    { x: 96, y: 80, rr: 8, max: 9, kind: 0, ex: 140, ey: 96, a: 21 },
    { x: 89, y: 56, rr: 4, max: 6, kind: 0, ex: 140, ey: 50, a: 26 },
    { x: 60, y: 101, rr: 3, max: 3, kind: 1, ex: 66, ey: 140, a: 30, rn: 1, lit: 4 },
    { x: 57, y: 19, rr: 4, max: 5, kind: 2, ex: 48, ey: -12, a: 34, rn: 2, lit: 10 }
  ];
  var NSAT = SATS.length, GSAT = 6;
  // J is the molecule's build, in ticks: two zoom drawings, then the centre materialises, its label types on,
  // our bond draws, and the others come in from the edges and bond. G is a graduation in miniature (satellite
  // 6, in launch): its gauge closes into a ring, the ring shows, then its bond draws.
  var JZ1 = 1, JZ2 = 5, JZ3 = 9, JC0 = 11, JC1 = 13, JC2 = 15, JL = 16, JB0 = 17;
  var GC = 10, GR = 11, GB = 13;
  var JMAX = 0, GMAX = 0;
  var KDOT = 10, CDA0 = new Float64Array(KDOT), CDA1 = new Float64Array(KDOT);
  for (var ck = 0; ck < KDOT; ck++) { CDA0[ck] = (-135 + 30 * ck) * DEG; CDA1[ck] = (-180 + (ck + 0.5) * 360 / KDOT) * DEG; }

  // An 8-connected line, both ends included.
  function bres(x0, y0, x1, y1) {
    var xs = [], ys = [], dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, e = dx + dy;
    for (;;) {
      xs.push(x0); ys.push(y0);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
    return { n: xs.length, x: xs, y: ys };
  }
  // Bond pixels outside a ring of radius r, counted from the satellite's side.
  function bondFromR(s, r) { var k = 0; r += 0.3; while (k < s.iE && s.ds[k] <= r) k++; return k; }
  (function () {
    for (var i = 0; i < NSAT; i++) {
      var s = SATS[i], k;
      s.path = bres(s.ex, s.ey, s.x, s.y); s.m = Math.ceil((s.path.n - 1) / 2);
      if (s.kind === 1) continue;
      var bd = bres(s.x - (MCX < s.x ? 1 : 0), s.y - (MCY < s.y ? 1 : 0), MCX - (s.x < MCX ? 1 : 0), MCY - (s.y < MCY ? 1 : 0));
      s.bx = new Int16Array(bd.n); s.by = new Int16Array(bd.n); s.ds = new Float32Array(bd.n); s.iE = 0;
      for (k = 0; k < bd.n; k++) {
        s.bx[k] = bd.x[k]; s.by[k] = bd.y[k];
        var dx = bd.x[k] + 0.5 - s.x, dy = bd.y[k] + 0.5 - s.y, ex = bd.x[k] + 0.5 - MCX, ey = bd.y[k] + 0.5 - MCY;
        s.ds[k] = Math.sqrt(dx * dx + dy * dy);
        if (ex * ex + ey * ey >= MCD) s.iE = k;
      }
      s.dir = norm(Math.atan2(MCX - s.x, -(MCY - s.y)));
      var len = s.iE - bondFromR(s, s.rr) + 1;
      if (s.kind === 2) { s.b = GB; GMAX = GB + len; }
      else { s.b = i === 0 ? JB0 : s.a + s.m + 2; JMAX = Math.max(JMAX, s.b + len); }
    }
    for (i = 0; i < NSAT; i++) JMAX = Math.max(JMAX, SATS[i].a + SATS[i].m + 1);
    JMAX = Math.max(JMAX, JL + 2 * CMPG.length + 1);
  })();

  /* ------------------------------------------------------------------ state */
  var placed = new Uint8Array(MAXN), taken = new Uint8Array(MAXN), stack = new Uint8Array(MAXN), n = 0;
  var shellCount = new Uint8Array(NSH);
  var flash = new Uint8Array(MAXN), nudT = new Uint8Array(MAXN), nudX = new Int8Array(MAXN), nudY = new Int8Array(MAXN);
  var jitX = new Int8Array(MAXN), jitY = new Int8Array(MAXN);
  var rN = 2, rLock = 4;

  var lit = 0, cT = 0, letters = 0, gtext = 0, dotted = 0, A = 0, R = 0;
  var o = new Int16Array(3);
  var eState = new Uint8Array(3), eT = new Uint8Array(3), ePos = new Float64Array(3);   // 0 none, 1 pop, 2 running
  var lClock = 0, gClock = 0;
  var ringFrac = 1, intro = false, ringDoneTick = -1;
  var tickN = 0;
  var ringFlash = 0, gaugeFlash = 0, blinkV = 0, blinkM = 0, glintSlot = -1, glintT = 0;
  var pendingTiles = 0, pendingGap = 0, cpCount = 0;
  var cpT = 0, gapT = 0, ambT = 20, lastLetters = 0;

  var T = { lit: 0, c: 0, o: new Int16Array(3), letters: 0, gtext: 0, dotted: 0, n: 0, tiles: false, gap: false, J: 0, G: 0 };

  // the molecule
  var J = 0, G = 0;
  var satR = new Int8Array(NSAT), satGrow = new Uint8Array(NSAT), satTw = new Uint8Array(NSAT), satHit = new Uint8Array(NSAT);
  var satPing = new Uint8Array(NSAT), satHx = new Int16Array(NSAT), satHy = new Int16Array(NSAT), stillGrow = new Uint8Array(NSAT);
  var cenGlint = 0, feedT = 20;

  function pool(size, make) { var a = []; for (var i = 0; i < size; i++) { var x = make(); x.on = 0; a.push(x); } return a; }
  function grab(a) { for (var i = 0; i < a.length; i++) if (!a[i].on) return a[i]; return null; }
  // tile: ph 0 materialise, 1 fall, 2 seam
  var tiles = pool(8, function () { return { kind: 0, ph: 0, t: 0, th: 0, cx: 0, cy: 0, ux: 0, uy: 0, x: 0, y: 0 }; });
  // gold block: ph 0 moving to its slot, 1 pop, 2 held (stills)
  var golds = pool(8, function () { return { kind: 0, ph: 0, t: 0, x0: 0, y0: 0, x1: 0, y1: 0, x: 0, y: 0, slot: -1 }; });
  // fragment: v 1 violet (buyback) / 0 grey (Meteora); ph 0 fly, 1 shrink
  var frags = pool(24, function () { return { v: 0, ph: 0, t: 0, cx: 0, cy: 0, tx: 0, ty: 0, ax: 0, ay: 0, bx: 0, by: 0 }; });
  // curve pixel
  var cps = pool(16, function () { return { x: 0, y: 0, ux: 0, uy: 0, th: 0, px: 0, py: 0 }; });
  // detached electron
  var frees = pool(6, function () { return { x: 0, y: 0, ux: 0, uy: 0 }; });
  // the molecule's own: a violet pixel running along a bond (lead: still on its way to the bond); a gold pixel
  // falling into a satellite; a pressed tile at satellite scale (ph 0 materialise, 1 fall, 2 seam, 3 split)
  var flows = pool(10, function () { return { s: 0, i: 0, lead: 0, x: 0, y: 0, px: 0, py: 0 }; });
  var feeds = pool(6, function () { return { s: 0, x: 0, y: 0, ux: 0, uy: 0, px: 0, py: 0 }; });
  var stiles = pool(6, function () { return { s: 0, ph: 0, t: 0, cx: 0, cy: 0, ux: 0, uy: 0, x: 0, y: 0 }; });

  var pNow = -1, decided = false, decideAt = 0, prevStage = 0;
  var rmq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reduced = !!(rmq && rmq.matches);
  var stillStage = -1, stillExtra = 0;
  var cursorOn = null;
  var onScreen = true;

  function stageOf(p) {
    return p < -0.5 ? COVER : p < 0 ? REWIND : p < 1 ? CURVE : p < 2 ? GRAD : p < 3 ? COMP : p < 4 ? FLOOR : p < 5 ? JOIN : LAUNCH;
  }
  function stillStageOf(p) { return p < -0.5 ? 0 : p < 1 ? 1 : p < 2 ? 2 : p < 3 ? 3 : p < 4 ? 4 : p < 5 ? 5 : 6; }
  function isEra(st) { return st === COVER || st >= COMP; }

  /* ------------------------------------------------------------------ nucleus ops */
  function recalcR(live) {
    var d2 = 0;
    for (var s = NSH - 1; s >= 0; s--) if (shellCount[s]) { d2 = SD2[SH0[s]]; break; }
    var rl = Math.ceil(Math.sqrt(d2)) + 4;
    if (live && rl > rLock && cT === 30 && ringFrac >= 1) ringFlash = 3;
    rLock = rl; rN = rl - 2;
  }
  // Lowest unfilled shell; nearest angle to theta, or the first slot in order when theta < 0.
  function chooseSlot(theta) {
    var k, k0 = -1;
    for (k = 0; k < MAXN; k++) if (!taken[k]) { k0 = k; break; }
    if (k0 < 0 || theta < 0) return k0;
    var s = SHELL[k0], best = k0, bd = 99;
    for (k = SH0[s]; k < SH1[s]; k++) {
      if (taken[k]) continue;
      var d = angDist(SA[k], theta);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }
  function place(k, live) {
    if (k < 0 || placed[k]) return;
    placed[k] = 1; taken[k] = 1; stack[n++] = k; shellCount[SHELL[k]]++;
    if (live) {
      flash[k] = 2;
      var px = SX[k], py = SY[k];
      for (var i = 0; i < n - 1; i++) {
        var q = stack[i], dx = SX[q] - px, dy = SY[q] - py;
        if (dx * dx + dy * dy <= 36) { nudX[q] = sgn(dx); nudY[q] = sgn(dy); nudT[q] = 3; }
      }
    }
    recalcR(live);
  }
  function removeLast() {
    if (!n) return;
    var k = stack[--n];
    placed[k] = 0; taken[k] = 0; shellCount[SHELL[k]]--; flash[k] = 0; nudT[k] = 0;
    if (k === glintSlot) glintT = 0;
    recalcR(false);
  }
  function resetNucleus() {
    placed.fill(0); taken.fill(0); shellCount.fill(0); flash.fill(0); nudT.fill(0); jitX.fill(0); jitY.fill(0);
    n = 0; glintSlot = -1; glintT = 0;
    recalcR(false);
  }
  function clearObjects() {
    var i;
    for (i = 0; i < tiles.length; i++) tiles[i].on = 0;
    for (i = 0; i < golds.length; i++) golds[i].on = 0;
    for (i = 0; i < frags.length; i++) frags[i].on = 0;
    for (i = 0; i < cps.length; i++) cps[i].on = 0;
    for (i = 0; i < frees.length; i++) frees[i].on = 0;
    for (i = 0; i < flows.length; i++) flows[i].on = 0;
    for (i = 0; i < feeds.length; i++) feeds[i].on = 0;
    for (i = 0; i < stiles.length; i++) stiles[i].on = 0;
    pendingTiles = 0; pendingGap = 0; cpCount = 0;
  }
  function resetSats() {
    for (var i = 0; i < NSAT; i++) { satR[i] = SATS[i].rr; satGrow[i] = 0; satTw[i] = 0; satHit[i] = 0; satPing[i] = 0; }
    cenGlint = 0; feedT = 20;
  }
  function fragsOn() { for (var i = 0; i < frags.length; i++) if (frags[i].on) return true; return false; }
  // Nothing of the big atom is still moving, so the camera may pull back.
  function bigQuiet() {
    var i;
    if (pendingTiles || cpCount) return false;
    for (i = 0; i < golds.length; i++) if (golds[i].on) return false;
    for (i = 0; i < frags.length; i++) if (frags[i].on) return false;
    for (i = 0; i < frees.length; i++) if (frees[i].on) return false;
    return true;
  }

  /* ------------------------------------------------------------------ targets */
  function computeTargets(st) {
    var p = pNow, u, k;
    T.lit = 28; T.c = 30; T.letters = 7; T.gtext = 0; T.dotted = 0; T.tiles = false; T.gap = false; T.J = 0; T.G = 0;
    for (k = 0; k < 3; k++) T.o[k] = OLEN[k];
    switch (st) {
      case COVER:
        T.n = Math.min(MAXN, 63 + A); T.tiles = true;
        break;
      case REWIND:
        T.lit = 0; T.c = 0; T.o[0] = T.o[1] = T.o[2] = 0; T.letters = 0; T.gtext = 7; T.n = 7;
        break;
      case CURVE:
        u = f85(clamp01(p));
        T.lit = Math.round(28 * u); T.c = 0; T.o[0] = T.o[1] = T.o[2] = 0; T.letters = 0; T.gtext = 7;
        T.n = 7 + Math.round(12 * u);
        break;
      case GRAD:
        u = p - 1;
        // Ring shut by u 0.2 and all three orbits drawn by 0.46, so the settled frame (u 0.5) is whole.
        T.c = Math.round(30 * clamp01((u - 0.02) / 0.18));
        for (k = 0; k < 3; k++) T.o[k] = Math.round(OLEN[k] * clamp01((u - 0.22 - 0.06 * k) / 0.12));
        T.letters = 0; T.gtext = Math.round(7 * (1 - cT / 30)); T.n = 19;
        break;
      case COMP:
        u = p - 2;
        T.n = Math.min(MAXN, Math.max(R, n, 19 + Math.round(44 * u) + A)); R = T.n;
        T.tiles = T.gap = true;
        break;
      case FLOOR:
        u = p - 3;
        // Lead-in to join from u 0.75: the orbits come back and the words and dotted ring go, so the whole atom
        // is ready to recede when the camera pulls back. No new tiles after the first moments of the frame.
        for (k = 0; k < 3; k++) T.o[k] = u < 0.75 ? 0 : Math.round(OLEN[k] * clamp01((u - 0.75) / 0.15));
        T.dotted = u >= 0.3 && u < 0.8 ? DOTLEN : 0;
        if (u >= 0.8) T.letters = 0;
        T.n = Math.min(MAXN, Math.max(R, n, 63 + A)); R = T.n;
        T.tiles = T.gap = u < 0.05;
        break;
      case JOIN:
        // Words and dotted ring go first and the orbits are whole (the gates), then the zoom, in which the orbits
        // recede with the nucleus; the molecule is whole by u 0.4.
        u = p - 4;
        T.letters = 0;
        T.n = Math.min(MAXN, Math.max(R, n, 63 + A)); R = T.n;
        T.J = Math.round(JMAX * clamp01((u - 0.05) / 0.35));
        break;
      default: // LAUNCH: the molecule stays, and one more coin graduates into it, whole by u 0.15
        u = p - 5;
        T.letters = 0;
        T.n = Math.min(MAXN, Math.max(R, n, 63 + A)); R = T.n;
        T.J = JMAX; T.G = Math.round(GMAX * clamp01((u - 0.02) / 0.13));
    }
  }

  /* ------------------------------------------------------------------ chasing, behind the ordering gates */
  function chase(st, era) {
    var k, allZero = !o[0] && !o[1] && !o[2];
    var allFull = o[0] === OLEN[0] && o[1] === OLEN[1] && o[2] === OLEN[2];

    if (cT === 0) {
      if (lit < T.lit) { lit++; if (lit === 28) gaugeFlash = 3; }
      else if (lit > T.lit) lit--;
    }
    if (cT < T.c) { if (lit === 28) { cT++; if (cT === 30) ringFlash = 3; } }
    else if (cT > T.c && allZero && !J) cT--;

    if (intro && ringFrac < 1 && n >= 40) {
      ringFrac += 8 / RINGS[rLock].n;
      if (ringFrac >= 1) { ringFrac = 1; ringDoneTick = tickN; }
    }
    for (k = 0; k < 3; k++) {
      if (o[k] < T.o[k]) {
        if (cT === 30 && !J && (!intro || (ringFrac >= 1 && tickN - ringDoneTick >= 5 * k))) o[k] = Math.min(T.o[k], o[k] + 10);
      } else if (o[k] > T.o[k] && !J) o[k] = Math.max(T.o[k], o[k] - 10);   // never unseen under the molecule
    }
    if (intro && o[0] === OLEN[0] && o[1] === OLEN[1] && o[2] === OLEN[2]) intro = false;

    if (lClock) lClock--;
    if (!lClock && letters !== T.letters) {
      // in join the words wait for the fragments still flying to them, so they land and blink first
      if (letters > T.letters) { if (st < JOIN || !fragsOn()) { letters--; lClock = 3; } }
      else if (cT === 30 && !J && (allFull || st === FLOOR)) { letters++; lClock = 3; }
    }
    if (gClock) gClock--;
    if (!gClock && gtext !== T.gtext) {
      if (gtext > T.gtext) { gtext--; gClock = 3; }
      else if (cT < 30) { gtext++; gClock = 3; }
    }
    if (dotted < T.dotted) { if (st === FLOOR && !J) dotted = Math.min(T.dotted, dotted + 4); }
    else if (dotted > T.dotted) dotted = Math.max(T.dotted, dotted - 4);

    // The nucleus. Outside the pool era it rewinds (last placed first); inside it only grows.
    var inflight = cpCount + pendingGap;
    if (n > T.n) {
      if (!era && !J && (st === GRAD || cT === 0)) { removeLast(); if (n > T.n) removeLast(); }
    } else if (n + inflight < T.n && !J) {
      var rate = 0;
      // Back on the cover: the pool only grows once the ring has closed (story order), the seed fills first.
      if (st === COVER || st === JOIN || st === LAUNCH) rate = cT === 30 ? 2 : (n < 19 ? 1 : 0);
      else if (st === GRAD || st === REWIND) rate = 1;
      else if (st === FLOOR && !T.tiles) rate = 1;
      else if (st === CURVE && n < 7) rate = 1;
      for (; rate > 0 && n + inflight < T.n; rate--) place(chooseSlot(-1), true);
    }

    // The molecule. It is built only from a whole, quiet big atom (ring shut, words and dotted ring gone, orbits
    // whole with their electrons running, nothing in flight), and taken down only once the miniature graduation has rewound and no pressed
    // tile is still in the air; until J is back at 0 the big atom's own gates hold everything else.
    // Once the label is typed, arrivals and bonds go two steps a tick while far behind (4 and 2 whole pixels).
    if (J < T.J) {
      if (J || (cT === 30 && !letters && !dotted && allFull && eState[0] === 2 && eState[1] === 2 && eState[2] === 2 && n >= T.n && bigQuiet())) {
        J = Math.min(T.J, J + (J > JL + 2 * CMPG.length && T.J - J > 6 ? 2 : 1));
      }
    } else if (J > T.J && !G && !pendingTiles) J = Math.max(T.J, J - 2);
    if (G < T.G) { if (J === JMAX) G++; }
    else if (G > T.G) G = Math.max(T.G, G - 2);
  }

  /* ------------------------------------------------------------------ electrons */
  function detach(k) {
    var e = grab(frees);
    if (!e) return;
    var ob = ORB[k], h = Math.floor(ePos[k]) % OLEN[k];
    e.on = 1; e.x = ob.x[h]; e.y = ob.y[h];
    var dx = e.x + 1 - 64, dy = e.y + 1 - 64, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.001) { dx = 0; dy = -1; d = 1; }
    e.ux = dx / d; e.uy = dy / d;
  }
  function electronsStep(st) {
    for (var k = 0; k < 3; k++) {
      var full = o[k] === OLEN[k];
      if (eState[k] === 2) {
        // Leaving in the floor frame they fly off (holders selling); in join the camera is only pulling back.
        if (!full) { if (st < JOIN) detach(k); eState[k] = 0; }
        else { ePos[k] += SPEED[k]; if (ePos[k] >= OLEN[k]) ePos[k] -= OLEN[k]; }
      } else if (eState[k] === 1) {
        if (!full) eState[k] = 0;
        else if (--eT[k] === 0) { eState[k] = 2; ePos[k] = 0; }
      } else if (full) { eState[k] = 1; eT[k] = 3; }
    }
  }

  /* ------------------------------------------------------------------ objects in flight */
  function resolveTile(kind) { pendingTiles--; if (kind === 0) pendingGap--; }

  function spawnFrag(v, cx, cy, tx, ty) {
    var f = grab(frags);
    if (!f) return null;
    f.on = 1; f.v = v; f.ph = 0; f.t = 0; f.cx = f.ax = f.bx = cx; f.cy = f.ay = f.by = cy; f.tx = tx; f.ty = ty;
    return f;
  }
  // The tile breaks along its seams: gold to a slot, violet to BUYBACK, grey to METEORA.
  function split(t, era) {
    var g = grab(golds);
    if (!g) resolveTile(t.kind);
    else {
      g.on = 1; g.kind = t.kind; g.x0 = g.x = t.x; g.y0 = g.y = t.y; g.t = 0; g.slot = -1;
      if (!era) { g.ph = 1; g.t = -1; resolveTile(g.kind); }
      else {
        var s = chooseSlot(t.th);
        if (s < 0) { g.on = 0; ringFlash = 3; resolveTile(g.kind); }   // 127: absorbed at the rim
        else { taken[s] = 1; g.slot = s; g.ph = 0; g.x1 = SX[s] - 2; g.y1 = SY[s] - 2; }
      }
    }
    if (era) {                                  // a split is only ever shown in the pool era
      spawnFrag(1, t.x + 5.5, t.y + 2, 111.5, 10.5);
      spawnFrag(0, t.x + 2.5, t.y + 5.5, 17.5, 117.5);
    }
  }
  function land(g, era) {
    if (g.slot >= 0) taken[g.slot] = 0;
    if (era && g.slot >= 0 && !placed[g.slot]) {
      place(g.slot, true);
      if (g.kind === 1) A++;
      g.on = 0;
    } else { g.ph = 1; g.t = 0; }
    g.slot = -1;
    resolveTile(g.kind);
  }

  function updateObjects(era, st) {
    var i, dx, dy, d, mol = st === JOIN || st === LAUNCH;
    for (i = 0; i < cps.length; i++) {
      var c = cps[i];
      if (!c.on) continue;
      c.px = Math.floor(c.x); c.py = Math.floor(c.y);
      c.x += c.ux; c.y += c.uy;
      dx = c.x - 64; dy = c.y - 64;
      if (dx * dx + dy * dy <= rN * rN) { c.on = 0; cpCount--; place(chooseSlot(c.th), true); }
    }
    for (i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (!t.on) continue;
      // caught outside the pool era, or still in the air when the camera is about to pull back: it pops where it
      // is and never splits (a split already under way finishes)
      if (!era || (mol && t.ph < 2)) {
        t.on = 0;
        var pg = grab(golds);
        if (pg) { pg.on = 1; pg.kind = t.kind; pg.ph = 1; pg.t = 0; pg.slot = -1; pg.x = Math.round(t.cx - 2.5); pg.y = Math.round(t.cy - 2.5); }
        resolveTile(t.kind);
        continue;
      }
      if (t.ph === 0) { if (++t.t >= 4) { t.ph = 1; t.t = 0; } }
      else if (t.ph === 1) {
        t.cx += t.ux; t.cy += t.uy;
        dx = t.cx - 64; dy = t.cy - 64; d = rLock + 4;
        if (dx * dx + dy * dy <= d * d) { t.ph = 2; t.t = 0; t.x = Math.round(t.cx - 2.5); t.y = Math.round(t.cy - 2.5); }
      } else if (++t.t >= 2) { t.on = 0; split(t, era); }
    }
    for (i = 0; i < golds.length; i++) {
      var g = golds[i];
      if (!g.on) continue;
      if (g.ph === 0) {
        g.t++;
        if (g.t <= 4) { g.x = Math.round(g.x0 + (g.x1 - g.x0) * g.t / 4); g.y = Math.round(g.y0 + (g.y1 - g.y0) * g.t / 4); }
        else land(g, era);
      } else if (g.ph === 1) { if (++g.t >= 4) g.on = 0; }
    }
    for (i = 0; i < frags.length; i++) {
      var f = frags[i];
      if (!f.on) continue;
      if (f.ph === 0) {
        f.bx = f.ax; f.by = f.ay; f.ax = f.cx; f.ay = f.cy;
        dx = f.tx - f.cx; dy = f.ty - f.cy; d = Math.sqrt(dx * dx + dy * dy);
        if (d <= 2.5) { f.cx = f.tx; f.cy = f.ty; f.ph = 1; f.t = 0; }
        else { f.cx += dx / d * 2.5; f.cy += dy / d * 2.5; }
      } else if (++f.t >= 4) {
        f.on = 0;
        if (letters >= 4) { if (f.v) blinkV = 2; else blinkM = 2; }
      }
    }
    for (i = 0; i < frees.length; i++) {
      var e = frees[i];
      if (!e.on) continue;
      e.x += e.ux * 3; e.y += e.uy * 3;
      if (e.x < -6 || e.x > W + 4 || e.y < -6 || e.y > W + 4) e.on = 0;
    }
  }

  /* ------------------------------------------------------------------ the molecule, each tick */
  // Our coin's drawn size follows its real nucleus, so seen from far away it never shrinks either.
  function ourRR() { return n < 80 ? 7 : n < 100 ? 8 : 9; }
  function satRR(i) { return i === 0 ? ourRR() : satR[i]; }
  function bondFrom(i) { return bondFromR(SATS[i], satRR(i)); }
  function bondCnt(i) {
    var s = SATS[i];
    if (s.kind === 1) return 0;
    var c = (s.kind === 2 ? G : J) - s.b;
    return c < 0 ? 0 : c;
  }
  function bonded(i) { return SATS[i].kind !== 1 && bondFrom(i) + bondCnt(i) - 1 >= SATS[i].iE; }
  var spX = 0, spY = 0;
  // Where satellite i is at the current J, in whole pixels along its way in; false before it sets off.
  function satAt(i) {
    var s = SATS[i], k = J - s.a;
    if (i === 0) { if (J < JZ3) return false; spX = s.x; spY = s.y; return true; }
    if (k <= 0) return false;
    var q = Math.min(2 * Math.min(k, s.m), s.path.n - 1);
    spX = s.path.x[q]; spY = s.path.y[q];
    return true;
  }
  // A satellite's own pool compounding: after a few arrivals it is drawn one size up. Ours grows its real n.
  function grow(i, units) {
    if (i === 0) { for (var k = 2 * units; k > 0 && n < MAXN; k--) place(chooseSlot(-1), false); return; }
    if (satR[i] >= SATS[i].max) return;
    satGrow[i] += units;
    if (satGrow[i] >= 5) { satGrow[i] = 0; satR[i]++; }
  }
  // lx > -99: it starts at (lx, ly) and first runs to the bond (a pressed tile's violet column)
  function spawnFlow(i, lx, ly) {
    var f = grab(flows);
    if (!f) return;
    f.on = 1; f.s = i; f.i = bondFrom(i); f.lead = lx > -99 ? 1 : 0;
    f.x = lx; f.y = ly; f.px = Math.floor(lx); f.py = Math.floor(ly);
  }
  // A trade in one bonded pool: its gold falls in, and as it lands a violet pixel leaves along the bond.
  function spawnFeed() {
    for (var tries = 0; tries < 4; tries++) {
      var i = Math.floor(rnd() * NSAT), th = rnd() * TAU;
      if (!bonded(i) || angDist(th, SATS[i].dir) < 60 * DEG) continue;
      var f = grab(feeds);
      if (!f) return false;
      var s = SATS[i], r = satRR(i) + 5, sn = Math.sin(th), cs = Math.cos(th);
      f.on = 1; f.s = i; f.x = s.x + r * sn; f.y = s.y - r * cs; f.ux = -sn; f.uy = cs;
      f.px = Math.floor(f.x); f.py = Math.floor(f.y);
      return true;
    }
    return false;
  }
  function nearestBonded(bx, by) {
    var best = -1, bd = 1e9;
    for (var i = 0; i < NSAT; i++) {
      if (!bonded(i)) continue;
      var dx = bx - SATS[i].x, dy = by - SATS[i].y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // Pressing the molecule drops a tile onto the bonded satellite nearest the press.
  function satPress(bx, by) {
    var i = nearestBonded(bx, by);
    if (i < 0 || pendingTiles >= 6) return;
    var t = grab(stiles);
    if (!t) return;
    var s = SATS[i], r = satRR(i), dx = bx - s.x, dy = by - s.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1) { dx = 0; dy = -1; d = 1; }
    var R0 = Math.max(r + 8, Math.min(d, r + 16));
    t.on = 1; t.s = i; t.ph = 0; t.t = 0;
    t.cx = Math.max(3, Math.min(125, s.x + dx / d * R0)); t.cy = Math.max(3, Math.min(125, s.y + dy / d * R0));
    dx = s.x - t.cx; dy = s.y - t.cy; d = Math.sqrt(dx * dx + dy * dy) || 1;
    t.ux = dx / d; t.uy = dy / d;
    pendingTiles++;
  }
  function moleculeStep(st) {
    var whole = J === JMAX, i, s, f, t, dx, dy, d, r;
    for (i = 0; i < flows.length; i++) {
      f = flows[i];
      if (!f.on) continue;
      s = SATS[f.s];
      if (!bonded(f.s)) { f.on = 0; continue; }            // its bond is being taken down
      if (f.lead) {
        var k0 = bondFrom(f.s);
        f.px = Math.floor(f.x); f.py = Math.floor(f.y);
        dx = s.bx[k0] + 0.5 - f.x; dy = s.by[k0] + 0.5 - f.y; d = Math.sqrt(dx * dx + dy * dy);
        if (d <= 2) { f.lead = 0; f.i = k0; } else { f.x += dx / d * 2; f.y += dy / d * 2; }
      } else if (++f.i > s.iE) { f.on = 0; cenGlint = 1; }  // it reaches the centre, which does not grow
    }
    for (i = 0; i < feeds.length; i++) {
      f = feeds[i];
      if (!f.on) continue;
      if (!whole || !bonded(f.s)) { f.on = 0; continue; }
      s = SATS[f.s]; r = satRR(f.s) - 2;
      f.px = Math.floor(f.x); f.py = Math.floor(f.y);
      f.x += f.ux; f.y += f.uy;
      dx = f.x - s.x; dy = f.y - s.y;
      if (dx * dx + dy * dy <= r * r) {
        f.on = 0; satPing[f.s] = 2; satHx[f.s] = Math.floor(f.x); satHy[f.s] = Math.floor(f.y);
        grow(f.s, 1); spawnFlow(f.s, -100, 0);
      }
    }
    for (i = 0; i < stiles.length; i++) {
      t = stiles[i];
      if (!t.on) continue;
      s = SATS[t.s];
      if (t.ph === 0) { if (++t.t >= 4) { t.ph = 1; t.t = 0; } }
      else if (t.ph === 1) {
        t.cx += t.ux; t.cy += t.uy;
        dx = t.cx - s.x; dy = t.cy - s.y; d = satRR(t.s) + 4;
        if (dx * dx + dy * dy <= d * d) { t.ph = 2; t.t = 0; t.x = Math.round(t.cx - 2.5); t.y = Math.round(t.cy - 2.5); }
      } else if (t.ph === 2) {
        if (++t.t >= 2) { t.ph = 3; t.t = 0; if (bonded(t.s)) spawnFlow(t.s, t.x + 5.5, t.y + 2); }
      } else {
        if (++t.t === 3) { grow(t.s, 3); satHit[t.s] = 2; }
        if (t.t >= 6) { t.on = 0; pendingTiles--; }
      }
    }
    if (whole && st >= JOIN) {
      if (feedT) feedT--;
      else if (spawnFeed()) feedT = 15 + Math.floor(rnd() * 31);
      if (tickN % 30 === 0) { i = Math.floor(rnd() * NSAT); if (bonded(i)) satTw[i] = 4; }
    }
  }

  /* ------------------------------------------------------------------ spawning */
  function freeAngle() {
    for (var tries = 0; tries < 5; tries++) {
      var th = rnd() * TAU, ok = true;
      for (var i = 0; i < tiles.length; i++) {
        if (tiles[i].on && angDist(tiles[i].th, th) < 30 * DEG) { ok = false; break; }
      }
      if (ok) return th;
    }
    return -1;
  }
  function spawnTile(th, kind) {
    if (th < 0) return false;
    var t = grab(tiles);
    if (!t) return false;
    var s = Math.sin(th), c = Math.cos(th);
    t.on = 1; t.kind = kind; t.ph = 0; t.t = 0; t.th = th;
    t.cx = 64 + 58 * s; t.cy = 64 - 58 * c; t.ux = -s; t.uy = c;
    pendingTiles++; if (kind === 0) pendingGap++;
    return true;
  }
  function spawnCP() {
    var c = grab(cps);
    if (!c) return false;
    var a = GA0[lit - 1];
    var x = Math.round(64 + 40 * Math.sin(a)), y = Math.round(64 - 40 * Math.cos(a));
    var dx = 64 - x, dy = 64 - y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    c.on = 1; c.x = x; c.y = y; c.px = x; c.py = y; c.ux = dx / d; c.uy = dy / d; c.th = norm(a);
    cpCount++;
    return true;
  }
  function setCursor(on) {
    if (on === cursorOn) return;
    cursorOn = on;
    canvas.style.cursor = on ? 'pointer' : 'default';
  }
  function spawn(st) {
    var allow = T.tiles && letters === 7;
    setCursor(allow || ((st === JOIN || st === LAUNCH) && J === JMAX));
    if (letters === 7 && lastLetters !== 7) ambT = 20;
    lastLetters = letters;

    if (cpT) cpT--;
    if (st === CURVE && cT === 0 && lit >= 1 && !cpT && n + cpCount < T.n && spawnCP()) cpT = 4;

    if (gapT) gapT--;
    if (allow && T.gap && !gapT && pendingTiles < 6 && n + pendingGap < T.n && spawnTile(freeAngle(), 0)) gapT = 5;

    if (allow) {
      if (ambT) ambT--;
      if (!ambT && pendingTiles < 6 && spawnTile(freeAngle(), 1)) ambT = 45 + Math.floor(rnd() * 31);
    }
  }

  /* ------------------------------------------------------------------ small life */
  function decay() {
    for (var i = 0; i < n; i++) { var k = stack[i]; if (flash[k]) flash[k]--; if (nudT[k]) nudT[k]--; }
    if (ringFlash) ringFlash--;
    if (gaugeFlash) gaugeFlash--;
    if (blinkV) blinkV--;
    if (blinkM) blinkM--;
    if (glintT) glintT--;
    if (cenGlint) cenGlint--;
    for (var s = 0; s < NSAT; s++) { if (satTw[s]) satTw[s]--; if (satHit[s]) satHit[s]--; if (satPing[s]) satPing[s]--; }
  }
  function life() {
    var i, k;
    if (cT < 15 && tickN % 8 === 0) {
      for (i = 0; i < n; i++) {
        k = stack[i];
        if (rnd() < 0.3) { jitX[k] = Math.floor(rnd() * 3) - 1; jitY[k] = Math.floor(rnd() * 3) - 1; }
      }
    }
    if (tickN % 24 === 0 && n > 0) {
      for (i = 0; i < 8; i++) {
        k = stack[Math.floor(rnd() * n)];
        if (!NEU[k] && litSide(k)) { glintSlot = k; glintT = 4; break; }
      }
    }
  }

  function tick() {
    tickN++;
    decay();
    var st = stageOf(pNow), era = isEra(st);
    if (!era) { R = 0; A = 0; }
    if (intro && st !== COVER) { intro = false; ringFrac = 1; }
    computeTargets(st);
    chase(st, era);
    electronsStep(st);
    updateObjects(era, st);
    moleculeStep(st);
    spawn(st);
    life();
  }

  /* ------------------------------------------------------------------ drawing */
  var TOFF = [7, 5, 4, 3, 2, 1], TCOL = [6, 6, 2, 2, 1, 1];   // gold, then orange, then dim against the orbit

  // A 2x2 head that always reaches forward along the orbit, so the trail starts right behind it.
  function head(ob, h, L, c) {
    var pq = h ? h - 1 : L - 1;
    rect(ob.x[h] - (ob.x[h] < ob.x[pq] ? 1 : 0), ob.y[h] - (ob.y[h] < ob.y[pq] ? 1 : 0), 2, 2, c);
  }

  function drawNucleons() {
    var bound = cT >= 15;
    for (var q = 0; q < MAXN; q++) {
      var k = ORDER[q];
      if (!placed[k]) continue;
      var x = SX[k] - 2, y = SY[k] - 2;
      if (!bound) { x += jitX[k]; y += jitY[k]; }
      if (nudT[k]) { x += nudX[k]; y += nudY[k]; }
      var neutron = NEU[k] === 1, lt = !neutron && litSide(k);
      var b = (neutron ? NEUTRON : lt ? PROTON : darkSide(k) ? PROTON_DARK : PROTON_FLAT).b, fl = flash[k] > 0;
      for (var i = 0; i < 16; i++) { var c = b[i]; if (c) put(x + (i & 3), y + (i >> 2), fl ? 4 : c); }
      if (!fl && lt && glintT && k === glintSlot) { put(x + 2, y + 1, 4); put(x + 1, y + 2, 4); put(x + 2, y + 2, 4); }
    }
  }
  function drawGauge() {
    var i;
    if (cT < 30) {
      var c = cT / 30, rad = 40 - (40 - rLock) * c;
      var blinkOff = !reduced && lit === T.lit && lit > 0 && lit < 28 && (tickN % 30) < 8;
      for (var k = 0; k < 28; k++) {
        var a = GA0[k] + (GA1[k] - GA0[k]) * c;
        var col = 9;
        if (k < lit) col = k === lit - 1 ? (blinkOff ? 9 : 4) : 1;
        if (gaugeFlash) col = 4;
        rect(Math.round(64 + rad * Math.sin(a)) - 1, Math.round(64 - rad * Math.cos(a)) - 1, 2, 2, col);
      }
    }
    for (i = 0; i < gtext; i++) {
      var g = GTG[i];
      drawGlyph(g, GTX[i], g.h === 7 ? 96 : 97, i < 3 ? 6 : (lit === 28 ? 1 : 6));
    }
  }
  function drawTile(x, y, seam) {
    rect(x, y, 4, 4, 1);
    rect(x + 4 + seam, y, 1, 4, 3);
    rect(x, y + 4 + seam, 5, 1, 5);
  }

  /* ------------------------------------------------------------------ drawing the molecule */
  function inDisc(dx, dy, r) { var X = dx + 0.5, Y = dy + 0.5; return X * X + Y * Y < r * r; }
  function blit(bm, x, y, white) {
    var b = bm.b, w = bm.w;
    for (var i = 0; i < b.length; i++) if (b[i]) put(x + i % w, y + ((i / w) | 0), white ? 4 : b[i]);
  }
  function ringAt(cx, cy, r, c) {
    var rg = RINGS[r], dx = cx - 64, dy = cy - 64;
    for (var i = 0; i < rg.n; i++) put(rg.x[i] + dx, rg.y[i] + dy, c);
  }
  var NUC1 = bitmap(['GG', 'GO'], SPR);
  // A nucleus seen from further away, in three levels of detail. From radius 8 (the zoom's middle drawings) it
  // is 3 px balls on a staggered grid, lit, flat or dark, with neutrons by the same 3-colouring as the big one;
  // smaller, a gold ball with a darker rim and a few neutron pixels; radius 1 and 2 are hand-drawn sprites.
  var CELL = {
    lit: bitmap(['GGG', 'GWG', 'GGO'], SPR).b, flat: bitmap(['GGG', 'GGG', 'GGO'], SPR).b,
    dark: bitmap(['GGG', 'GGO', 'GOO'], SPR).b, neu: bitmap(['OOO', 'OGO', 'OOO'], SPR).b
  };
  function coinNucleus(cx, cy, r, white) {
    if (r <= 2) { blit(r <= 1 ? NUC1 : PROTON, cx - r, cy - r, white); return; }
    var dx, dy, c;
    for (dy = -r; dy < r; dy++) {
      for (dx = -r; dx < r; dx++) {
        if (!inDisc(dx, dy, r)) continue;
        if (!inDisc(dx + 1, dy + 1, r)) c = 2;
        else if (r >= 8) {
          var j = Math.floor(dy / 3), off = j & 1, i = Math.floor((dx + off) / 3);
          var ccx = 3 * i - off + 1.5, ccy = 3 * j + 1.5, cell = ((((i - j) % 3) + 3) % 3 === 0 && (i || j)) ? CELL.neu
            : ccx + ccy < -0.45 * r ? CELL.lit : ccx + ccy > 0.45 * r ? CELL.dark : CELL.flat;
          c = cell[(dy - 3 * j) * 3 + (dx + off - 3 * i)];
        } else c = ((dy & 1) && ((dx + (((dy - 1) >> 1) & 1) * 2) & 3) === 1 && dx + dy > 1 - r) ? 2 : 1;
        put(cx + dx, cy + dy, white ? 4 : c);
      }
    }
    if (!white && r < 8) { var h = (r >> 1) + 1; put(cx - h, cy - h, 4); if (r >= 5) put(cx - h + 1, cy - h, 4); }
  }
  function sparkle(cx, cy, r) {
    var h = r <= 2 ? 1 : (r >> 1) + 1;
    put(cx - h, cy - h, 4); put(cx - h + 1, cy - h, 4); put(cx - h, cy - h + 1, 4);
  }
  // The camera pulls back about a fixed point, chosen so that the last drawing lands on our coin's place.
  var zgX = 0, zgY = 0, zgR = 0;
  function zoomGeom(z) {
    var rf = ourRR(), s0 = SATS[0], sf = rf / rLock;
    var fx = (s0.x - 64 * sf) / (1 - sf), fy = (s0.y - 64 * sf) / (1 - sf);
    zgR = Math.round(rf + (rLock - rf) * (z === 1 ? 0.55 : 0.25));
    var s = zgR / rLock;
    zgX = Math.round(fx + (64 - fx) * s); zgY = Math.round(fy + (64 - fy) * s);
  }
  // A middle drawing of the zoom: the whole atom, orbits and electrons too, drawn smaller, so it reads as the
  // camera pulling back and never as the pool shrinking. At J 9 the orbits drop as the coin becomes a satellite.
  // An electron is re-placed in proportion when a drawing starts, then runs one whole pixel a tick, as in the big atom.
  var zeLvl = 0, zeIdx = [0, 0, 0], zeT = 0;
  var ZTOFF = [[4, 3, 2, 1], [2, 1]], ZTCOL = [[6, 2, 1, 1], [2, 1]];
  function zHead(zo, h, zx, zy, big, c) {
    var x = zo.x[h] + zx, y = zo.y[h] + zy, pq = h ? h - 1 : zo.n - 1;
    if (big) rect(x - (zo.x[h] < zo.x[pq] ? 1 : 0), y - (zo.y[h] < zo.y[pq] ? 1 : 0), 2, 2, c);
    else put(x, y, c);
  }
  function drawZoom(lvl) {
    var zs = zgR / rLock, zx = zgX - 64, zy = zgY - 64, zr1 = (zgR - 1.5) * (zgR - 1.5), zr2 = zgR * zgR;
    var k, i, zo, zm, L, h, q, x, y, eh = [-1, -1, -1], to = ZTOFF[lvl - 1], tc = ZTCOL[lvl - 1];
    if (lvl !== zeLvl) {
      zeLvl = lvl; zeT = tickN;
      for (k = 0; k < 3; k++) zeIdx[k] = Math.round(ePos[k] * zorb(k, zs).n / OLEN[k]);
    }
    // back half of each orbit, dashed, and the electrons behind the nucleus
    for (k = 0; k < 3; k++) {
      zo = zorb(k, zs); L = zo.n; zm = Math.round(L * o[k] / OLEN[k]);
      for (i = 0; i < zm; i++) if (!zo.front[i] && !(i & 1)) put(zo.x[i] + zx, zo.y[i] + zy, 7);
      if (eState[k] !== 2) continue;
      h = eh[k] = (zeIdx[k] + tickN - zeT) % L;
      if (zo.front[h]) continue;
      q = h ? h - 1 : L - 1; put(zo.x[q] + zx, zo.y[q] + zy, 7);
      zHead(zo, h, zx, zy, lvl === 1, 5);
    }
    coinNucleus(zgX, zgY, zgR - 2, false);
    ringAt(zgX, zgY, zgR, 1);
    // front half: it passes behind the ring line and is dithered across the nucleus, as in the big atom
    for (k = 0; k < 3; k++) {
      zo = zorb(k, zs); L = zo.n; zm = Math.round(L * o[k] / OLEN[k]);
      for (i = 0; i < zm; i++) {
        if (!zo.front[i]) continue;
        x = zo.x[i] + zx; y = zo.y[i] + zy;
        if (x < 0 || x >= W || y < 0 || y >= W) continue;
        if (buf[(y << 7) + x] === 1 && zo.d2[i] >= zr1) continue;
        if (zo.d2[i] < zr2 && (i & 1)) continue;
        put(x, y, 7);
      }
    }
    for (k = 0; k < 3; k++) {
      h = eh[k];
      if (h < 0) continue;
      zo = zorb(k, zs); L = zo.n;
      if (!zo.front[h]) continue;
      for (i = 0; i < to.length; i++) { q = (h - to[i] + L) % L; put(zo.x[q] + zx, zo.y[q] + zy, tc[i]); }
      zHead(zo, h, zx, zy, lvl === 1, 4);
    }
  }
  // The Compound token: violet with a few white pixels, no gold and no ring.
  function drawCentre() {
    for (var dy = -MCR; dy < MCR; dy++) for (var dx = -MCR; dx < MCR; dx++) { var X = dx + 0.5, Y = dy + 0.5; if (X * X + Y * Y < MCD) put(MCX + dx, MCY + dy, 3); }
    put(MCX - 3, MCY - 4, 4); put(MCX - 4, MCY - 3, 4); put(MCX - 3, MCY - 3, 4);
    if (cenGlint) { put(MCX - 1, MCY - 1, 4); put(MCX, MCY - 1, 4); put(MCX - 1, MCY, 4); put(MCX, MCY, 4); put(MCX - 2, MCY - 2, 4); }
  }
  // cc 0 to 1: the gauge's dots fall inward and close, as in the graduate frame
  function drawCurveSat(i, x, y, cc) {
    var s = SATS[i], r0 = s.rn + 4, rr = satRR(i), rad = r0 - (r0 - rr) * cc;
    var blinkOff = !reduced && s.lit < KDOT && (tickN % 30) < 8;
    coinNucleus(x, y, s.rn, false);
    for (var k = 0; k < KDOT; k++) {
      var a = CDA0[k] + (CDA1[k] - CDA0[k]) * cc, col = 9;
      if (k < s.lit) col = k === s.lit - 1 ? (blinkOff ? 9 : 4) : 1;
      put(Math.floor(x + rad * Math.sin(a)), Math.floor(y - rad * Math.cos(a)), col);
    }
  }
  function drawSat(i, x, y) {
    var s = SATS[i];
    if (s.kind === 1) { drawCurveSat(i, x, y, 0); return; }
    if (s.kind === 2 && G < GR) { drawCurveSat(i, x, y, Math.min(G, GC) / GC); return; }
    var r = satRR(i), hit = satHit[i] > 0;
    coinNucleus(x, y, r - 2, hit);
    ringAt(x, y, r, s.kind === 2 && G < GR + 2 ? 4 : 1);
    if (!hit && satTw[i]) sparkle(x, y, r - 2);
    if (satPing[i]) put(satHx[i], satHy[i], 4);
  }
  function drawMolecule() {
    var i, k, s, c, f, t, x, y;
    // bonds, drawn on from the satellite with a white leading pixel, and what runs along them
    for (i = 0; i < NSAT; i++) {
      s = SATS[i];
      c = bondCnt(i);
      if (!c) continue;
      var k0 = bondFrom(i), k1 = Math.min(s.iE, k0 + c - 1);
      for (k = k0; k <= k1; k++) put(s.bx[k], s.by[k], 7);
      if (k1 < s.iE) put(s.bx[k1], s.by[k1], 4);
    }
    for (i = 0; i < flows.length; i++) {
      f = flows[i];
      if (!f.on) continue;
      s = SATS[f.s];
      if (f.lead) { put(f.px, f.py, 3); put(Math.floor(f.x), Math.floor(f.y), 3); continue; }
      put(s.bx[f.i], s.by[f.i], 3);
      if (f.i - 1 >= bondFrom(f.s)) put(s.bx[f.i - 1], s.by[f.i - 1], 3);
    }
    // the centre materialises like a tile, then its name types on
    if (J >= JC0) {
      if (J < JC1) rect(MCX - 1, MCY - 1, 2, 2, 4);
      else if (J < JC2) { for (y = -2; y < 2; y++) for (x = -2; x < 2; x++) if (inDisc(x, y, 2)) put(MCX + x, MCY + y, 4); }
      else drawCentre();
    }
    c = Math.max(0, Math.min(CMPG.length, (J - JL) >> 1));
    for (i = 0; i < c; i++) drawGlyph(CMPG[i], MCX - 16 + 4 * i, MCY + MCR + 5, 3);
    // the other coins, then ours (still a middle drawing of the zoom, or in its place)
    for (i = 1; i < NSAT; i++) if (satAt(i)) drawSat(i, spX, spY);
    if (J < JZ3) { zoomGeom(J < JZ2 ? 1 : 2); drawZoom(J < JZ2 ? 1 : 2); }
    else drawSat(0, SATS[0].x, SATS[0].y);
    // gold falling in, with an orange trail like a buy on the curve; pressed tiles
    for (i = 0; i < feeds.length; i++) {
      f = feeds[i];
      if (!f.on) continue;
      x = Math.floor(f.x); y = Math.floor(f.y);
      if (f.px !== x || f.py !== y) put(f.px, f.py, 2);
      put(x, y, 1);
    }
    for (i = 0; i < stiles.length; i++) {
      t = stiles[i];
      if (!t.on) continue;
      if (t.ph === 3) {
        s = SATS[t.s];
        if (t.t < 3) rect(Math.round(t.x + (s.x - 2 - t.x) * t.t / 3), Math.round(t.y + (s.y - 2 - t.y) * t.t / 3), 4, 4, 1);
        var w = t.t < 2 ? 5 : t.t < 4 ? 3 : 1;     // the grey row pops off and goes
        rect(t.x + ((5 - w) >> 1) - Math.round(t.ux * t.t), t.y + 5 - Math.round(t.uy * t.t), w, 1, 5);
        continue;
      }
      if (t.ph === 2) { drawTile(t.x, t.y, 1); continue; }
      x = Math.round(t.cx - 2.5); y = Math.round(t.cy - 2.5);
      if (t.ph === 1) drawTile(x, y, 0);
      else if (t.t < 2) put(x + 2, y + 2, 4);
      else rect(x + 1, y + 1, 3, 3, 4);
    }
  }
  function present() {
    for (var i = 0; i < 16384; i++) out[i] = LUT[buf[i]];
    ctx.putImageData(img, 0, 0);
  }

  function render() {
    var i, k, ob, h, L, x, y, q;
    buf.fill(0);
    if (!J || J >= JZ3) zeLvl = 0;
    if (J) { drawMolecule(); present(); return; }

    // 2. back orbit pixels
    for (k = 0; k < 3; k++) {
      ob = ORB[k];
      // the hidden half as a dashed line (the hidden-line convention), so depth reads away from the nucleus
      for (i = 0; i < o[k]; i++) if (!ob.front[i] && !(i & 1)) put(ob.x[i], ob.y[i], 7);
    }
    // 3. back electrons
    for (k = 0; k < 3; k++) {
      if (eState[k] !== 2) continue;
      ob = ORB[k]; L = OLEN[k]; h = Math.floor(ePos[k]) % L;
      if (ob.front[h]) continue;
      for (i = 2; i >= 1; i--) { q = h - i; if (q < 0) q += L; put(ob.x[q], ob.y[q], 7); }
      head(ob, h, L, 5);
    }
    // 4. gauge and its lettering
    drawGauge();
    // 5. nucleons
    drawNucleons();
    // 6. lock ring
    if (cT === 30) {
      var rg = RINGS[rLock], cnt = rg.n, col = ringFlash ? 4 : 1;
      if (ringFrac < 1) cnt = Math.floor(rg.n * ringFrac);
      for (i = 0; i < cnt; i++) put(rg.x[i], rg.y[i], col);
      if (ringFrac < 1 && cnt > 0) put(rg.x[cnt - 1], rg.y[cnt - 1], 4);
    }
    // 7. dotted floor ring
    // dithered by raster index (not screen parity, which leaves diagonals all on or all off): grey, then a cut
    for (i = 0; i < dotted; i++) put(DOTR.x[i], DOTR.y[i], (i & 1) ? 0 : 5);
    // 8. front orbit pixels, dithered by raster index where they cross the nucleus; they pass behind the ring line
    var rl2 = rLock * rLock, rr2 = (rLock - 1.5) * (rLock - 1.5);
    for (k = 0; k < 3; k++) {
      ob = ORB[k];
      for (i = 0; i < o[k]; i++) {
        if (!ob.front[i]) continue;
        x = ob.x[i]; y = ob.y[i];
        if (cT === 30 && buf[(y << 7) + x] === 1 && ob.d2[i] >= rr2) continue;
        if (ob.d2[i] < rl2 && (i & 1)) continue;
        put(x, y, 7);
      }
    }
    // 9. front electrons, pops, detached electrons
    for (k = 0; k < 3; k++) {
      ob = ORB[k]; L = OLEN[k];
      if (eState[k] === 1) {
        x = ob.x[0]; y = ob.y[0];
        put(x, y, 4); put(x - 1, y, 4); put(x + 1, y, 4); put(x, y - 1, 4); put(x, y + 1, 4);
      } else if (eState[k] === 2) {
        h = Math.floor(ePos[k]) % L;
        if (!ob.front[h]) continue;
        for (i = 0; i < 6; i++) { q = h - TOFF[i]; if (q < 0) q += L; put(ob.x[q], ob.y[q], TCOL[i]); }
        head(ob, h, L, 4);
      }
    }
    for (i = 0; i < frees.length; i++) {
      var e = frees[i];
      if (!e.on) continue;
      x = Math.floor(e.x); y = Math.floor(e.y);
      put(Math.floor(e.x + 1 - e.ux * 3), Math.floor(e.y + 1 - e.uy * 3), 7);
      put(Math.floor(e.x + 1 - e.ux * 2), Math.floor(e.y + 1 - e.uy * 2), 7);
      rect(x, y, 2, 2, 4);
    }
    // 10. curve pixels
    for (i = 0; i < cps.length; i++) {
      var c = cps[i];
      if (!c.on) continue;
      x = Math.floor(c.x); y = Math.floor(c.y);
      if (c.px !== x || c.py !== y) put(c.px, c.py, 2);
      put(x, y, 1);
    }
    // 11. tiles and gold blocks
    for (i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (!t.on) continue;
      if (t.ph === 2) { drawTile(t.x, t.y, 1); continue; }
      x = Math.round(t.cx - 2.5); y = Math.round(t.cy - 2.5);
      if (t.ph === 1) drawTile(x, y, 0);
      else if (t.t < 2) put(x + 2, y + 2, 4);
      else rect(x + 1, y + 1, 3, 3, 4);
    }
    for (i = 0; i < golds.length; i++) {
      var g = golds[i];
      if (!g.on) continue;
      if (g.ph === 1) { if (g.t < 2) rect(g.x + 1, g.y + 1, 2, 2, 1); else put(g.x + 1, g.y + 1, 4); }
      else rect(g.x, g.y, 4, 4, 1);
    }
    // 12. fragments and their trails
    for (i = 0; i < frags.length; i++) {
      var f = frags[i];
      if (!f.on) continue;
      var fc = f.v ? 3 : 5, w, hh;
      if (f.ph === 0 || f.t === 0) {
        put(Math.floor(f.bx), Math.floor(f.by), 7);
        put(Math.floor(f.ax), Math.floor(f.ay), fc);
      }
      if (f.ph === 0) { w = f.v ? 1 : 5; hh = f.v ? 4 : 1; }
      else if (f.t < 2) { w = f.v ? 1 : 3; hh = f.v ? 2 : 1; }
      else { w = 1; hh = 1; }
      rect(Math.round(f.cx - w / 2), Math.round(f.cy - hh / 2), w, hh, fc);
    }
    // 13. corner lettering
    for (i = 0; i < letters; i++) {
      drawGlyph(BUYG[i], 98 + 4 * i, 3, i === 3 && blinkV ? 4 : 3);
      drawGlyph(METG[i], 4 + 4 * i, 120, i === 3 && blinkM ? 4 : 5);
    }
    present();
  }

  /* ------------------------------------------------------------------ settle, intro, stills */
  function setElectrons() {
    for (var k = 0; k < 3; k++) {
      if (o[k] === OLEN[k]) { eState[k] = 2; ePos[k] = SETTLED[k]; } else eState[k] = 0;
      eT[k] = 0;
    }
  }
  function quiet() {
    ringFlash = gaugeFlash = blinkV = blinkM = glintT = 0;
    lClock = gClock = cpT = gapT = 0;
  }
  function settle() {
    clearObjects(); resetNucleus();
    intro = false; ringFrac = 1; A = 0; R = 0;
    var st = stageOf(pNow);
    cT = 0;
    computeTargets(st);
    lit = T.lit; cT = T.c; letters = T.letters; dotted = T.dotted;
    for (var k = 0; k < 3; k++) o[k] = T.o[k];
    gtext = st === GRAD ? Math.round(7 * (1 - cT / 30)) : T.gtext;
    for (var i = 0; i < T.n; i++) place(chooseSlot(-1), false);
    R = isEra(st) ? n : 0;
    resetSats(); J = T.J; G = T.G;
    setElectrons(); quiet();
    lastLetters = letters; ambT = 20;
    setCursor((T.tiles && letters === 7) || ((st === JOIN || st === LAUNCH) && J === JMAX));
  }
  function startIntro() {
    clearObjects(); resetNucleus(); resetSats();
    J = 0; G = 0;
    lit = 28; cT = 30; o[0] = o[1] = o[2] = 0; letters = 0; gtext = 0; dotted = 0;
    A = 0; R = 0; intro = true; ringFrac = 0; ringDoneTick = -1;
    setElectrons(); quiet();
    lastLetters = 0; ambT = 20;
    setCursor(false);
  }

  function frozenTile(radius, deg) {
    var t = grab(tiles);
    if (!t) return;
    var th = deg * DEG;
    t.on = 1; t.kind = 1; t.ph = 1; t.t = 0; t.th = th;
    t.cx = 64 + radius * Math.sin(th); t.cy = 64 - radius * Math.cos(th);
  }
  function frozenFrag(v, sx, sy, tx, ty) {
    var f = spawnFrag(v, (sx + tx) / 2, (sy + ty) / 2, tx, ty);
    if (!f) return;
    var dx = tx - sx, dy = ty - sy, d = Math.sqrt(dx * dx + dy * dy) || 1;
    f.ax = f.cx - dx / d * 2.5; f.ay = f.cy - dy / d * 2.5;
    f.bx = f.cx - dx / d * 5; f.by = f.cy - dy / d * 5;
  }
  function frozenSplit(deg) {
    var th = deg * DEG, rc = rLock + 4;
    var tx = Math.round(64 + rc * Math.sin(th) - 2.5), ty = Math.round(64 - rc * Math.cos(th) - 2.5);
    var g = grab(golds);
    if (g) { g.on = 1; g.ph = 2; g.x = tx; g.y = ty; g.slot = -1; }
    frozenFrag(1, tx + 5.5, ty + 2, 111.5, 10.5);
    frozenFrag(0, tx + 2.5, ty + 5.5, 17.5, 117.5);
  }
  function renderStill() {
    var ss = stillStageOf(pNow), k, i;
    if (ss !== stillStage) { stillStage = ss; stillExtra = 0; stillGrow.fill(0); }
    clearObjects(); resetNucleus(); resetSats();
    intro = false; ringFrac = 1; quiet(); J = 0; G = 0;
    var nn = 63, orbits = true, mol = ss >= 5;
    lit = 28; cT = 30; gtext = 0; dotted = 0; letters = 7;
    if (ss === 1) { lit = 14; cT = 0; gtext = 7; nn = 13; orbits = false; letters = 0; }
    else if (ss === 2) { nn = 19; letters = 0; }
    else if (ss === 3) nn = 43;
    else if (ss === 4) { orbits = false; dotted = DOTLEN; }
    else if (mol) { orbits = false; letters = 0; nn = stillGrow[0] ? (stillGrow[0] > 1 ? 100 : 80) : 63; }
    var press = ss === 0 || ss === 3;
    if (press) nn = Math.min(MAXN, nn + stillExtra);
    for (k = 0; k < 3; k++) o[k] = orbits ? OLEN[k] : 0;
    setElectrons();
    for (i = 0; i < nn; i++) place(chooseSlot(-1), false);
    if (ss === 1) {
      var jr = mulberry32(5);                       // a fixed, unbound look for the seed
      for (i = 0; i < n; i++) { k = stack[i]; jitX[k] = Math.floor(jr() * 3) - 1; jitY[k] = Math.floor(jr() * 3) - 1; }
      var c = grab(cps);                            // one buy on its way in from the leading dot
      if (c) {
        var a = GA0[lit - 1], sx = Math.round(64 + 40 * Math.sin(a)), sy = Math.round(64 - 40 * Math.cos(a));
        var dx = 64 - sx, dy = 64 - sy, d = Math.sqrt(dx * dx + dy * dy), steps = Math.round((d - rN) / 2);
        c.on = 1; c.ux = dx / d; c.uy = dy / d;
        c.x = sx + c.ux * steps; c.y = sy + c.uy * steps;
        c.px = Math.floor(c.x - c.ux); c.py = Math.floor(c.y - c.uy);
      }
    }
    if (ss === 0) { frozenTile(36, 300); frozenSplit(135); }
    else if (ss === 3) { frozenTile(40, 60); frozenSplit(225); }
    else if (mol) {
      // the settled molecule, each press grown in, and one violet pixel halfway along a bond
      J = JMAX; G = ss === 6 ? GMAX : 0;
      for (i = 1; i < NSAT; i++) satR[i] = Math.min(SATS[i].max, SATS[i].rr + stillGrow[i]);
      var fs = ss === 6 ? GSAT : 3, f = grab(flows);
      if (f) { var k0 = bondFrom(fs); f.on = 1; f.s = fs; f.lead = 0; f.i = (k0 + SATS[fs].iE + 1) >> 1; }
    }
    ringFlash = 0;
    setCursor((press || mol) && stillExtra < 20);
    render();
  }

  /* ------------------------------------------------------------------ clock and pausing */
  var raf = 0, last = -1, acc = 0;
  function wantRun() { return decided && !reduced && !document.hidden && onScreen; }
  function frame(t) {
    raf = 0;
    if (!wantRun()) return;
    if (last < 0) last = t;
    acc += t - last; last = t;
    var ran = 0;
    while (acc >= TICK && ran < 3) { tick(); acc -= TICK; ran++; }
    if (acc >= TICK) acc %= TICK;
    if (ran) render();
    raf = requestAnimationFrame(frame);
  }
  function syncLoop() {
    if (wantRun()) {
      if (!raf) { last = -1; acc = 0; raf = requestAnimationFrame(frame); }
    } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  /* ------------------------------------------------------------------ progress from page.js */
  function decide() {
    if (decided) return;
    decided = true;
    decideAt = now();
    prevStage = stageOf(pNow);
    if (reduced) { renderStill(); return; }
    if (pNow < -0.5) startIntro(); else settle();
    render();
    syncLoop();
  }
  function readP(v) {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    return v < -1 ? -1 : v > 5.999 ? 5.999 : v;
  }
  function onProgress(e) {
    var p = readP(e && e.detail ? e.detail.p : undefined);
    if (p === null) p = readP(window.compoundProgress);
    if (p === null) return;
    pNow = p;
    var st = stageOf(p);
    if (!decided) { decide(); prevStage = st; return; }
    if (reduced) {
      if (stillStageOf(p) !== stillStage) renderStill();
    } else if (now() - decideAt < 1000 && Math.abs(st - prevStage) >= 2) {
      settle(); render();
    }
    prevStage = st;
  }
  window.addEventListener('compound:progress', onProgress);

  /* ------------------------------------------------------------------ pressing the atom */
  canvas.addEventListener('click', function (e) {
    var r = canvas.getBoundingClientRect();
    if (!r.width || !r.height || !decided) return;
    var bx = (e.clientX - r.left) / r.width * 128, by = (e.clientY - r.top) / r.height * 128;
    var th = norm(Math.atan2(bx - 64, -(by - 64)));
    if (reduced) {
      if ((stillStage === 0 || stillStage === 3) && stillExtra < 20) { stillExtra++; renderStill(); }
      else if (stillStage >= 5 && stillExtra < 20) {
        var si = nearestBonded(bx, by);
        if (si >= 0) { stillGrow[si]++; stillExtra++; renderStill(); }
      }
      return;
    }
    var st = stageOf(pNow);
    if (st === JOIN || st === LAUNCH) { if (J === JMAX) satPress(bx, by); return; }
    if (T.tiles && letters === 7 && pendingTiles < 6) spawnTile(th, 1);
  });

  /* ------------------------------------------------------------------ sizing: whole device pixels */
  var cssSide = -1, scaleNow = 0, dprNow = 0, sizeRaf = 0;
  function snap(dpr) {
    canvas.style.transform = 'none';
    var r = canvas.getBoundingClientRect();
    var fx = (Math.round(r.left * dpr) - r.left * dpr) / dpr, fy = (Math.round(r.top * dpr) - r.top * dpr) / dpr;
    canvas.style.transform = 'translate(' + (Math.round(fx * 1e4) / 1e4) + 'px,' + (Math.round(fy * 1e4) / 1e4) + 'px)';
  }
  function size() {
    var parent = canvas.parentElement;
    if (!parent) return;
    var box = Math.min(parent.clientWidth, parent.clientHeight);
    var dpr = window.devicePixelRatio || 1;
    if (!(box > 0)) return;
    var s = Math.max(1, Math.floor(box * dpr / 128 + 1e-6));
    var css = 128 * s / dpr;
    if (css !== cssSide) { canvas.style.width = css + 'px'; canvas.style.height = css + 'px'; }
    snap(dpr);
    if (css !== cssSide || s !== scaleNow || dpr !== dprNow) {
      cssSide = css; scaleNow = s; dprNow = dpr;
      try {
        window.dispatchEvent(new CustomEvent('compound:atomsize', { detail: { css: css, scale: s, dpr: dpr } }));
      } catch (err) { /* very old engines: page.js falls back to measuring the canvas */ }
    }
    if (reduced && decided) render();
  }
  function scheduleSize() {
    if (!sizeRaf) sizeRaf = requestAnimationFrame(function () { sizeRaf = 0; size(); });
  }

  function onMQ(mq, fn) { if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn); }
  function offMQ(mq, fn) { if (mq.removeEventListener) mq.removeEventListener('change', fn); else if (mq.removeListener) mq.removeListener(fn); }
  var dprMq = null;
  function watchDpr() {
    if (!window.matchMedia) return;
    if (dprMq) offMQ(dprMq, onDpr);
    dprMq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    onMQ(dprMq, onDpr);
  }
  function onDpr() { watchDpr(); size(); }

  size();
  watchDpr();
  window.addEventListener('resize', scheduleSize);
  window.addEventListener('load', scheduleSize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleSize, function () {});
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(scheduleSize);
    ro.observe(canvas.parentElement);
    if (canvas.parentElement.parentElement) ro.observe(canvas.parentElement.parentElement);
  }
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[entries.length - 1].isIntersecting;
      syncLoop();
    }).observe(canvas);
  }
  document.addEventListener('visibilitychange', syncLoop);

  if (rmq) {
    onMQ(rmq, function () {
      reduced = rmq.matches;
      if (!decided) return;
      if (reduced) { syncLoop(); stillStage = -1; renderStill(); }
      else { settle(); render(); syncLoop(); }
    });
  }

  setCursor(false);
  var first = readP(window.compoundProgress);
  if (first !== null) { pNow = first; decide(); }
  else setTimeout(function () { if (!decided) { pNow = -1; decide(); } }, 300);
})();
