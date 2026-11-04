document.documentElement.classList.add('js');

// Compound landing page: turns the scroll into one coin's timeline p, tells the atom, and keeps the
// film strip in step. atom.js draws; this file never touches the canvas besides measuring it.
(function () {
  'use strict';

  const root = document.documentElement;
  const stage = document.getElementById('stage');
  const atom = document.getElementById('atom');
  const strip = document.getElementById('strip');
  const probe = document.getElementById('vh-probe');
  const wordmark = document.getElementById('wordmark');
  const ids = ['curve', 'graduate', 'compound', 'floor', 'join', 'launch'];
  const N = ids.length; // p runs from -1 (cover) to N - 0.001; section i settles at p = i + 0.5
  const secs = ids.map((id) => document.getElementById(id));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  if (!stage || !atom || !strip || !probe || secs.some((s) => !s)) return;

  const nav = Array.prototype.map.call(strip.querySelectorAll('a[data-step]'), (a) => ({
    a,
    i: Number(a.getAttribute('data-step')),
    segs: a.querySelectorAll('.meter i'),
    state: '',
    on: -1,
  }));

  let smooth = !reduced.matches;
  let mode = 'tall';
  let atomCss = null; // canvas side in CSS px, from compound:atomsize
  let vh = window.innerHeight || 1;
  const top = new Array(N).fill(0);
  const h = new Array(N).fill(0);
  const Z = new Array(N).fill(0);
  let lastP = NaN;
  const vars = {};

  function setVar(name, value) {
    if (vars[name] === value) return;
    vars[name] = value;
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }

  // All layout reads happen here.
  function layout() {
    mode = getComputedStyle(root).getPropertyValue('--mode').trim() || 'tall';
    let css = atomCss;
    if (!(css > 0)) css = atom.getBoundingClientRect().height;
    if (!(css > 0)) css = 0;
    setVar('--atom-css', css + 'px');
    if (mode === 'tall') {
      setVar('--band', (56 + css + 12) + 'px');
      setVar('--navh', strip.offsetHeight + 'px');
    } else {
      setVar('--band', null);
      setVar('--navh', '0px');
    }
    vh = probe.getBoundingClientRect().height || window.innerHeight || 1;
    const sy = window.scrollY || window.pageYOffset || 0;
    for (let i = 0; i < N; i++) {
      top[i] = secs[i].getBoundingClientRect().top + sy;
      h[i] = secs[i].offsetHeight;
      Z[i] = top[i] + (h[i] - vh) / 2; // the scroll at which section i's block sits centred in its reading window
    }
  }

  function progress() {
    const y = window.scrollY || window.pageYOffset || 0;
    let p;
    if (y < Z[0]) {
      p = Z[0] > 0 ? -1 + 1.5 * y / Z[0] : 0.5;
    } else if (y >= Z[N - 1]) {
      p = N - 0.5 + (h[N - 1] > 0 ? (y - Z[N - 1]) / h[N - 1] : 0);
    } else {
      p = N - 0.5;
      for (let i = 0; i < N - 1; i++) {
        if (y < Z[i + 1]) {
          const span = Z[i + 1] - Z[i];
          p = i + 0.5 + (span > 0 ? (y - Z[i]) / span : 0);
          break;
        }
      }
    }
    if (!Number.isFinite(p)) p = -1;
    return Math.min(N - 0.001, Math.max(-1, p));
  }

  function updateNav(p) {
    for (const n of nav) {
      const i = n.i;
      const state = p < i ? 'is-future' : p < i + 1 ? 'is-current' : 'is-past';
      const on = state === 'is-future' ? 0
        : state === 'is-past' ? 8
          : Math.min(8, Math.max(0, Math.floor((p - i) * 8)));
      if (state !== n.state) {
        if (n.state) n.a.classList.remove(n.state);
        n.a.classList.add(state);
        if (state === 'is-current') n.a.setAttribute('aria-current', 'step');
        else n.a.removeAttribute('aria-current');
        n.state = state;
      }
      if (on !== n.on) {
        for (let k = 0; k < n.segs.length; k++) {
          const want = k < on;
          if (n.on < 0 || (k < n.on) !== want) n.segs[k].classList.toggle('on', want);
        }
        n.on = on;
      }
    }
  }

  function update(force) {
    const p = progress();
    if (force || !(Math.abs(p - lastP) <= 0.0001)) {
      lastP = p;
      window.compoundProgress = p;
      window.dispatchEvent(new CustomEvent('compound:progress', { detail: { p } }));
    }
    updateNav(p);
  }

  function relayout() {
    layout();
    update(true);
  }

  function hashIndex() {
    let id = location.hash.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* keep it raw */ }
    return ids.indexOf(id);
  }

  // ---- first layout, and a deep link lands on the section's settled frame ----
  layout();
  const firstHash = hashIndex();
  let hashY = NaN; // where the early deep-link scroll put the page
  if (firstHash >= 0) { window.scrollTo(0, Z[firstHash]); hashY = Z[firstHash]; }

  // After fonts or load move the sections, re-centre a deep link the reader has not scrolled away from:
  // either the browser's own jump to the section top, or our early scroll, is still in place.
  function reanchor() {
    const i = hashIndex();
    if (i < 0) return;
    const y = window.scrollY || window.pageYOffset || 0;
    if (Math.abs(y - top[i]) < 4 || (i === firstHash && Math.abs(y - hashY) < 4)) {
      window.scrollTo(0, Z[i]);
      hashY = Z[i];
      update(false);
    }
  }

  // ---- listeners ----
  let scrollQueued = false;
  window.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; update(false); });
  }, { passive: true });

  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; relayout(); });
  });

  window.addEventListener('compound:atomsize', (e) => {
    const css = e && e.detail ? Number(e.detail.css) : NaN;
    if (css > 0) atomCss = css;
    relayout();
  });

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { relayout(); reanchor(); });

  window.addEventListener('load', () => {
    relayout();
    reanchor();
  });

  const onReduced = () => { smooth = !reduced.matches; };
  if (reduced.addEventListener) reduced.addEventListener('change', onReduced);
  else if (reduced.addListener) reduced.addListener(onReduced);

  const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

  for (const n of nav) {
    n.a.addEventListener('click', (e) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      const i = n.i;
      window.scrollTo({ top: Z[i], behavior: smooth ? 'smooth' : 'auto' });
      history.replaceState(null, '', '#' + ids[i]);
      // From the keyboard, carry focus to the section so reading and tabbing continue there.
      if (e.detail === 0) {
        const sec = secs[i];
        if (!sec.hasAttribute('tabindex')) sec.setAttribute('tabindex', '-1');
        try { sec.focus({ preventScroll: true }); } catch (err) { /* old browsers */ }
      }
    });
  }

  if (wordmark) {
    wordmark.addEventListener('click', (e) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
      history.replaceState(null, '', location.pathname + location.search);
    });
  }

  // Last step of init: tell the atom where the page is, synchronously.
  update(true);
})();
