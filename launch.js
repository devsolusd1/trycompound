/*
 * Compound /launch: a test coin from a wallet, on devnet, with no Solana library in the page.
 *
 * The server (POST /api/launch) builds the unsigned transaction; this page only handles its bytes. The coin's mint key
 * is made here with WebCrypto and never leaves the page: the server only ever sees its public key.
 *
 * Signing order: the wallet signs first, because a wallet may change a transaction and any change would break an
 * earlier signature. The page then signs the message of the transaction the wallet returned with the mint key and
 * writes that signature into the mint's slot. If the wallet took the mint out of the signers or changed who pays, the
 * launch stops. A wallet with no solana:signTransaction gets the mint's signature first and sends the transaction
 * itself with solana:signAndSendTransaction.
 *
 * Sending goes through the server, so no RPC URL reaches the browser. The signature is known before sending (it is the
 * fee payer's), so a lost answer costs nothing: the page keeps asking for the status of that signature and that mint,
 * and the button stays off until the chain has settled it. That holds across a reload through sessionStorage
 * 'compound:launch:pending' (a public signature and mint, read and written in try/catch).
 *
 * The gauge is the landing's open curve in one buffer of palette indices: a dot lights gold only once its share of the
 * curve is full, the next one shows orange while it is being filled, and the nucleus is the SOL the buy leaves in the
 * curve, on the same scale as the coins page. Under the curve it letters the symbol, as the coins page does. It flashes
 * once, in whole pixels, when a coin lands; not under reduced motion.
 *
 * DOM: main#launch-main and everything inside it, plus #connect and #wallet-panel. Needs window.compoundWallet from
 * wallet.js. Defines no globals. Under node (no document) it exports the byte helpers, for the tests.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ bytes */
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const SIG = 64, KEY = 32;

  class Plain extends Error {}                    // a message written for the page, safe to show as it is

  function asBytes(x) {
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (x instanceof ArrayBuffer || Array.isArray(x)) return new Uint8Array(x);
    throw new Plain('That is not a transaction.');
  }

  function b58encode(input) {
    const bytes = asBytes(input), digits = [];    // little-endian, base 58
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    for (let i = zeros; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let k = 0; k < digits.length; k++) {
        carry += digits[k] * 256;
        digits[k] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
    }
    let out = '1'.repeat(zeros);
    for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
    return out;
  }

  function toB64(input) {
    const bytes = asBytes(input);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(text) {
    const s = atob(text), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // A length in Solana's wire format: seven bits a byte, low bits first, three bytes at most.
  function readCompact(b, at) {
    let value = 0;
    for (let size = 0; size < 3; size++) {
      if (at + size >= b.length) break;
      const byte = b[at + size];
      value |= (byte & 0x7f) << (7 * size);
      if (!(byte & 0x80)) return { value: value, size: size + 1 };
    }
    throw new Plain('That transaction cannot be read.');
  }

  // [count][64 bytes per signature][message]. A message opens with one version byte if its top bit is set (v0 is 0x80),
  // then the header (required signatures, then two read-only counts), the static keys, the blockhash, the instructions.
  // The required signers are the first keys, in the same order as the signature slots; the first is the fee payer.
  function parseTx(input) {
    const b = asBytes(input), bad = () => new Plain('That transaction cannot be read.');
    const count = readCompact(b, 0), sigStart = count.size, msgStart = sigStart + SIG * count.value;
    if (msgStart >= b.length) throw bad();
    let p = msgStart, version = 'legacy';
    if (b[p] & 0x80) {
      version = b[p] & 0x7f;
      if (version !== 0) throw bad();
      p++;
    }
    if (p + 3 >= b.length) throw bad();
    const required = b[p];
    p += 3;
    const keyCount = readCompact(b, p);
    p += keyCount.size;
    if (required < 1 || required > keyCount.value || required !== count.value) throw bad();
    if (p + KEY * keyCount.value + KEY > b.length) throw bad();
    const signers = [];
    for (let i = 0; i < required; i++) signers.push(b58encode(b.subarray(p + KEY * i, p + KEY * (i + 1))));
    return {
      bytes: b, version: version, sigCount: count.value, sigStart: sigStart, msgStart: msgStart, required: required,
      keyCount: keyCount.value, message: b.subarray(msgStart), signers: signers, feePayer: signers[0],
      blockhash: b58encode(b.subarray(p + KEY * keyCount.value, p + KEY * keyCount.value + KEY))
    };
  }

  function sigAt(tx, slot) {
    const at = tx.sigStart + SIG * slot;
    return tx.bytes.subarray(at, at + SIG);
  }
  function hasSig(tx, slot) { return sigAt(tx, slot).some((x) => x !== 0); }

  // The mint's slot, once the transaction is checked: this wallet pays, and the mint is a required signer.
  function mintSlot(tx, wallet, mint) {
    if (tx.feePayer !== wallet) throw new Plain('The fee payer changed, so nothing was sent.');
    const slot = tx.signers.indexOf(mint);
    if (slot < 1) throw new Plain("The coin's key is no longer a signer of this transaction, so nothing was sent.");
    return slot;
  }

  function writeSig(tx, slot, sig) {
    const out = tx.bytes.slice();
    out.set(asBytes(sig), tx.sigStart + SIG * slot);
    return out;
  }

  const helpers = { asBytes, b58encode, toB64, fromB64, readCompact, parseTx, sigAt, hasSig, mintSlot, writeSig };
  if (typeof module === 'object' && module && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;

  /* ------------------------------------------------------------------ the page */
  const $ = (id) => document.getElementById(id);
  const main = $('launch-main');
  if (!main) return;
  const form = $('l-form'), fields = $('l-fields'), btn = $('l-btn'), go = $('l-go'), panel = $('l-done');
  const nameEl = $('l-name'), symbolEl = $('l-symbol'), imageEl = $('l-image'), buyEl = $('l-buy'), prev = $('l-prev');
  const stepEl = $('l-step'), quoteEl = $('l-quote');
  const API = main.getAttribute('data-launch') || '/api/launch';
  const UPLOAD = main.getAttribute('data-upload') || '/api/upload';

  const NAME_MAX = 32, SYMBOL_MAX = 10, IMAGE_MAX = 1024 * 1024;
  const POLL = 1500, QUOTE_WAIT = 280, RETRY_INFO = 15000, REFRESH_GAP = 10000;
  const WALLET_WAIT = 120000;                    // a wallet that never answers: nothing has been sent, so it is safe to stop
  const SLOW = 30000;                            // when to say it is taking long
  const GIVE_UP = 300000;                        // a blockhash lives about a minute and a half; this is well past it
  const REMEMBER_FOR = 600000;
  const PENDING = 'compound:launch:pending';
  const NO_KEYS = "This browser can't make the coin's key (it needs Ed25519). Use a recent Chrome, Edge, Firefox or Safari.";
  const NOT_SIGNED = "Your wallet couldn't sign this. Check that it's set to devnet, then try again.";
  const NO_QUOTE = "Couldn't get a quote just now.";
  const READING = 'Reading the curve...';
  const EMPTY_CURVE = 'No first buy: the curve opens empty. Its dots light as it fills.';
  const EXPIRED = 'The transaction expired before it landed. Nothing was spent. Press the button to try again.';

  const wallet = window.compoundWallet || null;
  let who = wallet ? wallet.current() : null;     // { address, name } or null
  let info = null;                                // the last good answer to the info step
  let infoWhy = '';                               // why the service can't be used right now
  let infoAt = 0, infoSeq = 0, infoRetry = 0;
  let keysOk = true;
  let busy = false;                               // a launch is under way, or may have landed
  let finished = false;
  let picture = null;                             // { dataUrl }
  let pictureError = '', pickSeq = 0;
  let uploaded = null;                            // { key, uri }: reused while the name, symbol and image stay the same
  let quote = null;                               // { firstBuySol, shareOfSupply, progress }
  let quoteTimer = 0, quoteSeq = 0, quoteFailed = '';
  const touched = {};

  const rmq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function say(text) { if (stepEl.textContent !== text) stepEl.textContent = text; }
  function setLine(el, text) {
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const safeText = (x) => (typeof x === 'string' ? x.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim().slice(0, 240) : '');
  const utf8 = (s) => new TextEncoder().encode(s).length;
  const shortMint = (m) => m.slice(0, 4) + '…' + m.slice(-4);

  /* ------------------------------------------------------------------ numbers in words */
  function trimmed(text) { return text.indexOf('.') < 0 ? text : text.replace(/\.?0+$/, ''); }
  const fmtExact = (x) => trimmed(x.toFixed(9));
  const fmtSol = (x) => trimmed(Number(x.toPrecision(3)).toFixed(9));
  const fmtDown = (x, places) => {                // never shows more than there is
    const p = Math.pow(10, places);
    return trimmed((Math.floor(x * p + 1e-9) / p).toFixed(places));
  };
  function fmtBalance(x) { return x > 0 && x < 0.001 ? 'under 0.001' : fmtDown(x, 3); }
  function fmtShare(p) {
    if (p > 0 && p < 0.001) return 'under 0.1%';
    return trimmed((Math.round(p * 1000) / 10).toFixed(1)) + '%';
  }
  function fmtFill(p) { return p < 0.01 ? 'under 1%' : Math.min(99, Math.round(p * 100)) + '%'; }

  /* ------------------------------------------------------------------ server */
  class ApiError extends Plain {
    constructor(message, code, status) { super(message); this.code = code; this.status = status; }
  }
  async function post(url, body, ms) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const to = ctrl ? setTimeout(() => ctrl.abort(), ms) : 0;
    let res, json = null;
    try {
      res = await fetch(url, {
        method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined
      });
      try { json = await res.json(); } catch (err) { json = null; }
    } catch (err) {
      throw new ApiError("Couldn't reach the server. Check your connection and try again.", 'network', 0);
    } finally {
      clearTimeout(to);
    }
    if (!res.ok || !json || typeof json !== 'object') {
      throw new ApiError(safeText(json && json.error) || 'The server had a problem. Try again in a moment.', safeText(json && json.code) || 'server', res.status);
    }
    return json;
  }
  const api = (step, body, ms) => post(API, Object.assign({ step: step }, body), ms);

  /* ------------------------------------------------------------------ the gauge */
  // 0 empty, 1 gold, 2 orange, 4 white, 5 muted, 6 dim: the same indices as coins.js
  const HEX = ['', 'F5BD00', 'F54B00', '', 'F5F5FF', '9595B2', '6C6C89'];
  // the landing's open curve, from its bottom left, clockwise
  const ARC = [[6, 28], [4, 24], [3, 21], [2, 17], [3, 13], [4, 9], [6, 6], [10, 4], [13, 3], [17, 2], [21, 3], [24, 4], [28, 6], [30, 9], [31, 13], [32, 17], [31, 21], [30, 24], [28, 28]];
  const SEED_X = 18, SEED_Y = 18;
  const SVGNS = 'http://www.w3.org/2000/svg';
  // The 3x5 font of coins.js. The same limits too: up to 8 letters and digits, or no lettering at all.
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
  const GAUGE_W = 35, GAUGE_H = 37, LABEL_Y = 31;

  function surface(w, h) { return { w: w, h: h, b: new Uint8Array(w * h) }; }
  function put(S, x, y, c) { if (x >= 0 && x < S.w && y >= 0 && y < S.h) S.b[y * S.w + x] = c; }
  function paint(svg, S) {
    const paths = {};
    for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) {
      const c = S.b[y * S.w + x];
      if (c) paths[c] = (paths[c] || '') + 'M' + x + ' ' + y + 'h1v1h-1z';
    }
    svg.textContent = '';
    Object.keys(paths).forEach((c) => {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', paths[c]);
      p.setAttribute('fill', '#' + HEX[c]);
      svg.appendChild(p);
    });
  }
  // The nucleus as coins.js draws a small one, so a coin looks the same on both pages.
  const SPRITES = { 1: ['GG', 'GO'], 2: ['.GG.', 'GWGG', 'GGGO', '.GO.'] };
  const SPRITE_INK = { G: 1, O: 2, W: 4 };
  function inDisc(dx, dy, r) { const X = dx + 0.5, Y = dy + 0.5; return X * X + Y * Y < r * r; }
  function nucleus(S, cx, cy, r, white) {
    if (r <= 2) {
      SPRITES[r].forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          const c = SPRITE_INK[row.charAt(x)];
          if (c) put(S, cx - r + x, cy - r + y, white ? 4 : c);
        }
      });
      return;
    }
    for (let dy = -r; dy < r; dy++) for (let dx = -r; dx < r; dx++) {
      if (!inDisc(dx, dy, r)) continue;
      let c = 1;
      if (!inDisc(dx + 1, dy + 1, r)) c = 2;
      else if ((dy & 1) && ((dx + (((dy - 1) >> 1) & 1) * 2) & 3) === 1 && dx + dy > 1 - r) c = 2;
      put(S, cx + dx, cy + dy, white ? 4 : c);
    }
    if (!white) { const h = (r >> 1) + 1; put(S, cx - h, cy - h, 4); if (r >= 5) put(S, cx - h + 1, cy - h, 4); }
  }
  // One size per doubling from 0.125 SOL, as on the coins page for devnet; 5 is the largest there on a curve.
  function seedSize(sol) {
    if (!(sol > 0)) return 0;
    return Math.max(1, Math.min(5, sol >= 0.125 ? 2 + Math.floor(Math.log2(sol / 0.125) + 1e-9) : 1));
  }
  function litDots(p) {
    if (!(p > 0)) return 0;
    return p >= 1 ? ARC.length : Math.min(ARC.length - 1, Math.floor(p * ARC.length + 1e-4));
  }
  function drawGauge(white) {
    const S = surface(GAUGE_W, GAUGE_H), p = quote ? quote.progress : 0, lit = litDots(p);
    const part = p > 0 && lit < ARC.length && p * ARC.length > lit + 1e-4;    // the dot being filled: it claims no fullness
    ARC.forEach((d, k) => {
      let c = 6;
      if (k < lit) c = k === lit - 1 ? 4 : 1;
      else if (k === lit && part) c = 2;
      if (white) c = 4;
      put(S, d[0], d[1], c);
    });
    // the SOL in the curve, which is what the coins page sizes by
    const inCurve = quote && info && isNum(info.graduationSol) ? quote.progress * info.graduationSol : quote ? quote.firstBuySol : 0;
    const r = seedSize(inCurve);
    if (r) nucleus(S, SEED_X, SEED_Y, r, white);
    const sym = textOf(symbolEl).toUpperCase();
    if (sym.length <= 8 && Array.from(sym).every((c) => FONT[c])) {
      const x0 = Math.floor((GAUGE_W - (4 * sym.length - 1)) / 2);
      Array.from(sym).forEach((c, i) => FONT[c].forEach((row, y) => {
        for (let x = 0; x < 3; x++) if (row[x] === '#') put(S, x0 + 4 * i + x, LABEL_Y + y, white ? 4 : 5);
      }));
    }
    paint($('l-gauge'), S);
  }
  function flashGauge() {
    if (rmq && rmq.matches) return;
    drawGauge(true);
    setTimeout(() => drawGauge(false), 240);
  }
  function drawPickFrame() {
    const S = surface(34, 34), ink = imageEl.getAttribute('aria-invalid') === 'true' ? 2 : picture ? 1 : 6;
    for (let i = 0; i <= 33; i += 3) { put(S, i, 0, ink); put(S, i, 33, ink); put(S, 0, i, ink); put(S, 33, i, ink); }
    if (!picture) {
      for (let i = 13; i <= 20; i++) for (let k = 16; k <= 17; k++) { put(S, i, k, 6); put(S, k, i, 6); }
    }
    paint($('l-frame'), S);
  }

  /* ------------------------------------------------------------------ the form */
  function textOf(el) { return el.value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, '').trim(); }
  function readBuy() {
    const s = buyEl.value.trim().replace(',', '.');
    if (!s) return { sol: 0, err: '' };
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return { sol: 0, err: 'Enter an amount in SOL, like 0.3.' };
    if ((s.split('.')[1] || '').length > 9) return { sol: 0, err: 'SOL has 9 decimal places at most.' };
    const sol = Number(s), max = info && isNum(info.maxFirstBuySol) ? info.maxFirstBuySol : null;
    if (max != null && sol > max) return { sol: 0, err: 'This test curve takes at most ' + fmtDown(max, 6) + ' SOL.' };
    return { sol: sol, err: '' };
  }
  function bytesError(text, max, missing, word) {
    if (!text) return missing;
    const n = utf8(text);
    return n > max ? word + ' can be up to ' + max + ' bytes. This one is ' + n + '.' : '';
  }
  function setError(el, errEl, text) {
    setLine(errEl, text);
    const was = el.getAttribute('aria-invalid');
    if (text) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
    if (el === imageEl && was !== el.getAttribute('aria-invalid')) drawPickFrame();
  }
  function setCount(el, text, max) {
    const n = utf8(text);
    setLine(el, n >= Math.ceil(max * 0.8) ? n + ' of ' + max + ' bytes' : '');
  }
  // The whole form: what it holds, and whether it could launch. Errors show on a field once it has been left or
  // the form has been tried.
  function check(all) {
    if (all) touched.name = touched.symbol = touched.image = true;
    const name = textOf(nameEl), symbol = textOf(symbolEl), buy = readBuy();
    const errs = {
      name: bytesError(name, NAME_MAX, 'Give the coin a name.', 'Names'),
      symbol: bytesError(symbol, SYMBOL_MAX, 'Give the coin a symbol.', 'Symbols'),
      image: pictureError || (picture ? '' : 'Pick an image.'),
      buy: buy.err
    };
    setError(nameEl, $('l-name-err'), touched.name ? errs.name : '');
    setError(symbolEl, $('l-symbol-err'), touched.symbol ? errs.symbol : '');
    setError(imageEl, $('l-image-err'), touched.image ? errs.image : '');
    setError(buyEl, $('l-buy-err'), errs.buy);
    setCount($('l-name-count'), name, NAME_MAX);
    setCount($('l-symbol-count'), symbol, SYMBOL_MAX);
    const first = errs.name ? nameEl : errs.symbol ? symbolEl : errs.image ? imageEl : errs.buy ? buyEl : null;
    return { ok: !first, first: first, name: name, symbol: symbol, firstBuySol: buy.sol };
  }

  /* ------------------------------------------------------------------ the image */
  function sniff(b) {
    const at = (i, list) => list.every((x, k) => b[i + k] === x), ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
    if (at(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
    if (at(0, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
    if (at(0, ascii('GIF87a')) || at(0, ascii('GIF89a'))) return 'image/gif';
    if (at(0, ascii('RIFF')) && at(8, ascii('WEBP'))) return 'image/webp';
    return '';
  }
  function dropPicture(why) {
    picture = null;
    pictureError = why;
    prev.hidden = true;
    prev.removeAttribute('src');
    touched.image = true;
    drawPickFrame();
    refresh();
  }
  async function pick(file) {
    const my = ++pickSeq;
    if (file.size > IMAGE_MAX) { dropPicture('The image must be 1 MB or smaller.'); return; }
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (err) { if (my === pickSeq) dropPicture("That file can't be read."); return; }
    if (my !== pickSeq) return;
    const type = sniff(bytes);
    if (!type) { dropPicture('Use a PNG, JPEG, GIF or WebP image.'); return; }
    picture = { dataUrl: 'data:' + type + ';base64,' + toB64(bytes) };
    pictureError = '';
    touched.image = true;
    prev.setAttribute('src', picture.dataUrl);
    prev.hidden = false;
    drawPickFrame();
    refresh();
  }

  /* ------------------------------------------------------------------ the quote */
  function showQuote() {
    const buy = readBuy();
    if (buy.err) setText(quoteEl, 'Fix the amount to see what it buys.');
    else if (!buy.sol) setText(quoteEl, EMPTY_CURVE);
    else if (quote) {
      const share = fmtShare(quote.shareOfSupply);
      setText(quoteEl, 'A ' + fmtExact(quote.firstBuySol) + ' SOL first buy gets ' + (share.startsWith('under') ? '' : 'about ') + share + ' of the supply and ' +
        (quote.progress >= 1 ? 'fills this test curve.' : 'fills ' + fmtFill(quote.progress) + ' of this test curve.'));
    } else if (quoteFailed) setText(quoteEl, quoteFailed);
    else if (!info && !infoWhy) setText(quoteEl, READING);
    else if (!info || !info.open) setText(quoteEl, NO_QUOTE);
    drawGauge(false);
  }
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
  function askQuote() {
    clearTimeout(quoteTimer);
    const my = ++quoteSeq, buy = readBuy();
    quoteFailed = '';
    if (buy.err || !buy.sol || !info || !info.open) { quote = null; showQuote(); return; }
    if (quote && quote.firstBuySol === buy.sol) { showQuote(); return; }
    if (!quote) setText(quoteEl, READING);      // a quote already shown names its own amount, so it stays true meanwhile
    quoteTimer = setTimeout(async () => {
      try {
        const q = await api('quote', { firstBuySol: buy.sol }, 12000);
        if (my !== quoteSeq) return;
        if (!isNum(q.firstBuySol) || !isNum(q.shareOfSupply) || !isNum(q.progress)) throw new Error('shape');
        quote = { firstBuySol: q.firstBuySol, shareOfSupply: Math.max(0, Math.min(1, q.shareOfSupply)), progress: Math.max(0, Math.min(1, q.progress)) };
      } catch (err) {
        if (my !== quoteSeq) return;
        quote = null;
        quoteFailed = err.status >= 400 && err.status < 500 ? err.message : NO_QUOTE;
      }
      showQuote();
    }, QUOTE_WAIT);
  }

  /* ------------------------------------------------------------------ what the page shows */
  const usable = () => !!wallet && (wallet.canSign() || (!!wallet.canSend && wallet.canSend()));
  function reason() {
    if (!keysOk) return NO_KEYS;
    if (infoWhy) return infoWhy;
    if (info && !info.open) return 'Launching is closed right now.';
    if (who && !usable()) return "This wallet can't sign transactions on this page. Try Phantom, Solflare or Backpack.";
    return '';
  }
  const readForThisWallet = () => !!who && !!info && info.wallet === who.address;
  const costOf = (buy) => info.costSol + (buy > 0 ? info.firstBuyRentSol : 0);
  function needsMore(buy) {
    // a first buy also holds the rent of its wrapped SOL account while it runs; that rent comes back, so it is not a cost
    return readForThisWallet() && isNum(info.balanceSol) && isNum(info.costSol) && info.balanceSol < costOf(buy) + buy + (buy > 0 ? info.firstBuyRentSol : 0);
  }
  function setRow(id, valueEl, text) {
    setText(valueEl, text);
    $(id).hidden = !text;
  }
  function refresh() {
    const buy = check(false).firstBuySol, why = reason();
    const hasCost = !!info && isNum(info.costSol), mine = readForThisWallet(), hasBalance = mine && isNum(info.balanceSol);
    setRow('l-cost-row', $('l-cost'), hasCost ? fmtSol(costOf(buy)) : '');
    setRow('l-first-row', $('l-first'), hasCost && buy > 0 ? fmtExact(buy) : '');
    setRow('l-bal-row', $('l-bal'), hasBalance ? fmtBalance(info.balanceSol) : '');
    $('l-bal-err').hidden = !mine || hasBalance;
    setLine($('l-grad'), info && isNum(info.graduationSol)
      ? 'Test coins graduate with ' + fmtSol(info.graduationSol) + ' SOL in the curve. Real ones will graduate at about $25k of market cap.' : '');
    const low = needsMore(buy);
    $('l-low').hidden = !low;
    $('l-mode').hidden = !who;
    setLine($('l-why'), why);
    const ready = !why && !!info;
    if (busy) { btn.textContent = 'Launch on devnet'; btn.disabled = true; }
    else if (!who) { btn.textContent = ready ? 'Connect a wallet first' : 'Launch on devnet'; btn.disabled = !ready; }
    else { btn.textContent = 'Launch on devnet'; btn.disabled = !ready || low; }
    fields.disabled = busy;
  }

  async function loadInfo() {
    const my = ++infoSeq;
    clearTimeout(infoRetry);
    try {
      const j = await api('info', who ? { wallet: who.address } : {}, 12000);
      if (my !== infoSeq) return;
      infoAt = Date.now();
      infoWhy = '';
      // this page launches on devnet only, whatever an answer says
      info = {
        wallet: who ? who.address : null, open: j.open === true && j.cluster === 'devnet', balanceSol: isNum(j.balanceSol) ? j.balanceSol : null,
        costSol: isNum(j.costSol) ? j.costSol : null, firstBuyRentSol: isNum(j.firstBuyRentSol) ? j.firstBuyRentSol : 0, graduationSol: isNum(j.graduationSol) ? j.graduationSol : null,
        maxFirstBuySol: isNum(j.maxFirstBuySol) ? j.maxFirstBuySol : null
      };
      askQuote();
    } catch (err) {
      if (my !== infoSeq) return;
      infoWhy = err.status ? err.message : "Couldn't reach the launch service. Trying again in a moment.";
      infoRetry = setTimeout(loadInfo, RETRY_INFO);
    }
    refresh();
  }

  /* ------------------------------------------------------------------ keys and the wallet */
  async function newMint() {
    const subtle = window.crypto && window.crypto.subtle;
    if (!subtle) throw new Plain(NO_KEYS);
    try {
      const pair = await subtle.generateKey('Ed25519', false, ['sign', 'verify']);
      const raw = await subtle.exportKey('raw', pair.publicKey);
      return { pair: pair, address: b58encode(new Uint8Array(raw)) };
    } catch (err) {
      throw new Plain(NO_KEYS);
    }
  }
  async function signWithMint(mint, message) {
    return new Uint8Array(await window.crypto.subtle.sign('Ed25519', mint.pair.privateKey, message));
  }
  function inTime(promise, ms) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Plain("Your wallet didn't answer, so nothing was sent. Try again.")), ms);
      promise.then((v) => { clearTimeout(to); resolve(v); }, (e) => { clearTimeout(to); reject(e); });
    });
  }
  function walletFailed(err, words) {
    if (err instanceof Plain || (err && err.rejected)) return err;
    return new Plain(words);
  }

  // Wallet first, then the mint, over what the wallet returned; then through the server. Fills in run.signature.
  async function signThenSend(run, unsigned, mint) {
    let back;
    try {
      back = await inTime(wallet.signTransaction(unsigned), WALLET_WAIT);
    } catch (err) {
      throw walletFailed(err, NOT_SIGNED);
    }
    let tx;
    try { tx = parseTx(back); } catch (err) { throw new Plain('Your wallet returned a transaction this page cannot read, so nothing was sent.'); }
    const slot = mintSlot(tx, run.address, run.mint);
    if (!hasSig(tx, 0)) throw new Plain('Your wallet returned the transaction without signing it, so nothing was sent.');
    if (tx.blockhash !== parseTx(unsigned).blockhash) run.lastValidBlockHeight = null;    // the height from build is not this one's
    const signed = writeSig(tx, slot, await signWithMint(mint, tx.message));
    run.signature = b58encode(sigAt(parseTx(signed), 0));
    remember(run);
    say('Sending...');
    try {
      await api('send', { transaction: toB64(signed) }, 30000);
    } catch (err) {
      // A 4xx is the server refusing it: it went nowhere. Anything else may have reached the chain, so it gets watched,
      // and so does "that mint exists", which for a key made a moment ago can only mean this transaction landed.
      if (err.status >= 400 && err.status < 500 && err.code !== 'mint_exists') { forget(); throw err; }
    }
  }

  // A wallet that can only send: the mint signs the built transaction and the wallet signs and sends it. The launch is
  // remembered before the wallet acts, with the mint's signature to watch by, because a wallet that fails or a page that
  // reloads leaves no way to know if it was broadcast. status then settles it by whether the mint exists, or by expiry.
  // So the button stays off until then, and a second press can't make a second coin.
  async function signThenWalletSends(run, plain, mint) {
    const mintSig = await signWithMint(mint, plain.message);
    const signed = writeSig(plain, mintSlot(plain, run.address, run.mint), mintSig);
    run.signature = b58encode(mintSig);
    remember(run);
    try {
      const sent = await inTime(wallet.signAndSend(signed), WALLET_WAIT);
      run.signature = typeof sent === 'string' ? sent : b58encode(sent);
      remember(run);
    } catch (err) {
      if (err && err.rejected) { forget(); throw err; }
      // anything else: the outcome is unknown, so follow() watches the mint
    }
  }

  /* ------------------------------------------------------------------ one launch */
  function remember(run) {
    try {
      window.sessionStorage.setItem(PENDING, JSON.stringify({
        signature: run.signature, mint: run.mint, name: run.name, symbol: run.symbol, lastValidBlockHeight: run.lastValidBlockHeight, at: Date.now()
      }));
    } catch (err) { /* no storage: only a reload loses track of it */ }
  }
  function forget() {
    try { window.sessionStorage.removeItem(PENDING); } catch (err) { /* no storage */ }
  }
  function recall() {
    try {
      const r = JSON.parse(window.sessionStorage.getItem(PENDING));
      if (r && typeof r.signature === 'string' && typeof r.mint === 'string' && Date.now() - r.at < REMEMBER_FOR) return r;
      forget();
    } catch (err) { /* no storage */ }
    return null;
  }

  async function uriFor(f) {
    const key = f.name + '\u0000' + f.symbol + '\u0000' + picture.dataUrl;
    if (uploaded && uploaded.key === key) return uploaded.uri;
    say('Uploading the image...');
    const j = await post(UPLOAD, { name: f.name, symbol: f.symbol, image: picture.dataUrl }, 40000);
    if (typeof j.uri !== 'string' || !j.uri) throw new Plain('The upload gave no address for the image. Try again.');
    uploaded = { key: key, uri: j.uri };
    return j.uri;
  }

  // Polls until the chain has settled it. Only a clear answer ends this, so while the server can't be reached the
  // button stays off.
  async function follow(run) {
    const start = Date.now();
    say('Waiting for the chain...');
    for (;;) {
      let j = null;
      try {
        j = await api('status', { signature: run.signature, mint: run.mint, lastValidBlockHeight: run.lastValidBlockHeight }, 10000);
      } catch (err) { /* unknown: ask again */ }
      if (j) {
        if (j.exists === true || j.state === 'confirmed') return;
        if (j.state === 'failed') {
          forget();
          console.warn(safeText(j.error));
          throw new Plain('The launch failed on the chain, so no coin was made. Only the network fee was spent. Press the button to try again.');
        }
        if (j.state === 'expired' || (j.exists === false && Date.now() - start > GIVE_UP)) {
          forget();
          throw new ApiError(EXPIRED, 'expired', 410);
        }
      }
      if (Date.now() - start > SLOW) say('Still waiting for the chain. Keep this page open.');
      await sleep(POLL);
    }
  }

  function succeed(run) {
    forget();
    busy = false;
    finished = true;
    form.hidden = true;
    go.hidden = true;
    say('');
    const scan = 'https://solscan.io/token/' + encodeURIComponent(run.mint) + '?cluster=devnet';
    setText($('l-done-name'), run.symbol && run.symbol !== run.name ? run.name + ' (' + run.symbol + ')' : run.name || shortMint(run.mint));
    setText($('l-done-mint'), shortMint(run.mint));
    $('l-done-mint').setAttribute('title', run.mint);
    $('l-done-coins').setAttribute('href', '/coins#' + encodeURIComponent(run.mint));
    $('l-done-scan').setAttribute('href', scan);
    copyMint = run.mint;
    if (picture) {
      $('l-done-img').setAttribute('src', picture.dataUrl);
      $('l-done-img').hidden = false;
    }
    panel.hidden = false;
    $('l-done-name').focus();
    flashGauge();
  }
  function stop(err) {
    $('l-quote').parentNode.hidden = false;
    busy = false;
    let text = 'Something went wrong, so nothing was sent. Try again.';
    if (err && err.rejected) text = 'You cancelled in your wallet.';
    else if (err && /expired|blockhash/i.test(err.code || '')) text = EXPIRED;
    else if (err instanceof Plain) text = err.message;
    say(text);
    refresh();
    (btn.disabled ? stepEl : btn).focus();
  }

  async function launch() {
    const f = check(true);
    if (!f.ok) { f.first.focus(); return; }
    if (busy || !who || !wallet) return;
    busy = true;
    refresh();
    stepEl.scrollIntoView({ block: 'nearest' });
    const walletName = who.name;
    const run = { address: who.address, name: f.name, symbol: f.symbol, mint: '', signature: '', lastValidBlockHeight: null };
    try {
      const uri = await uriFor(f);
      say('Preparing the transaction...');
      const mint = await newMint();
      run.mint = mint.address;
      const built = await api('build', { wallet: run.address, mint: run.mint, name: f.name, symbol: f.symbol, uri: uri, firstBuySol: f.firstBuySol }, 30000);
      run.lastValidBlockHeight = isNum(built.lastValidBlockHeight) ? built.lastValidBlockHeight : null;
      let unsigned, plain;
      try {
        unsigned = fromB64(built.transaction);
        plain = parseTx(unsigned);
        mintSlot(plain, run.address, run.mint);
      } catch (err) {
        throw new Plain("The server's transaction doesn't match this launch, so nothing was sent.");
      }
      say('Check ' + walletName + ' to approve.');
      if (wallet.canSign()) await signThenSend(run, unsigned, mint);
      else await signThenWalletSends(run, plain, mint);
      await follow(run);
      succeed(run);
    } catch (err) {
      stop(err);
    }
  }

  /* ------------------------------------------------------------------ events */
  function openWallet() {
    const c = $('connect'), p = $('wallet-panel');
    if (!c) return;
    if (!p || p.hidden) c.click();
    else c.focus();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy || finished) return;
    if (!who) { if (!btn.disabled) openWallet(); return; }
    if (!btn.disabled) launch();
  });
  // Enter sends the form only when the form is good; otherwise it shows what to fix.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target || e.target.tagName !== 'INPUT' || e.target.type === 'file') return;
    const f = check(true);
    if (!f.ok) { e.preventDefault(); f.first.focus(); }
  });
  nameEl.addEventListener('blur', () => { touched.name = true; refresh(); });
  symbolEl.addEventListener('blur', () => { touched.symbol = true; refresh(); });
  nameEl.addEventListener('input', refresh);
  symbolEl.addEventListener('input', () => { refresh(); drawGauge(false); });
  buyEl.addEventListener('input', () => { refresh(); askQuote(); });
  imageEl.addEventListener('change', () => {
    const file = imageEl.files && imageEl.files[0];
    if (file) pick(file);
  });
  prev.addEventListener('error', () => { if (picture) dropPicture("That image can't be read. Pick another."); });

  window.addEventListener('compound:wallet', (e) => {
    const d = e.detail || {};
    who = d.address ? { address: d.address, name: d.name } : null;
    refresh();
    if (!finished) loadInfo();
  });
  // Back from the faucet, or from switching the wallet's mode: read the balance again.
  window.addEventListener('focus', () => {
    if (who && !busy && !finished && Date.now() - infoAt > REFRESH_GAP) loadInfo();
  });

  let copyMint = '', copyTimer = 0;
  const copyBtn = $('l-done-copy');
  function copied(ok) {
    copyBtn.textContent = ok ? 'copied' : 'copy failed';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyBtn.textContent = 'copy'; }, 1600);
  }
  copyBtn.addEventListener('click', () => {
    const fallback = () => {
      try {
        const t = document.createElement('textarea');
        t.value = copyMint;
        t.setAttribute('readonly', '');
        t.style.position = 'fixed';
        t.style.top = '-1000px';
        document.body.appendChild(t);
        t.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(t);
        copied(ok);
      } catch (err) { copied(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(copyMint).then(() => copied(true), fallback);
    else fallback();
  });

  /* ------------------------------------------------------------------ start */
  drawGauge(false);
  drawPickFrame();
  refresh();
  newMint().catch(() => { keysOk = false; refresh(); });     // says so now, not after the form is filled in
  loadInfo();
  const pending = recall();
  if (pending) {
    $('l-quote').parentNode.hidden = true;        // the form is blank after a reload, so the gauge can't describe this coin
    busy = true;
    refresh();
    follow(pending).then(() => succeed(pending), stop);
  }
})();
