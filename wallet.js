// Compound wallet button. Finds Solana wallets through the Wallet Standard (no libraries) and connects one.
// This file never sends, stores or logs the address; the launch page sends it to /api/launch to read its
// balance and build its transaction. Only the wallet's name is remembered, so a later visit can reconnect
// without a prompt. Works on every page and needs nothing from atom.js or page.js. Tells later code about
// changes with window event 'compound:wallet', and offers signing as window.compoundWallet (devnet only).
(function () {
  'use strict';

  const box = document.getElementById('wallet');
  const btn = document.getElementById('connect');
  if (!box || !btn) return;

  let panel = document.getElementById('wallet-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'wallet-panel';
    panel.className = 'panel';
    box.appendChild(panel);
  }
  panel.hidden = true;
  panel.textContent = '';
  const view = document.createElement('div'); // rebuilt on every render
  view.className = 'view';
  const msg = document.createElement('p'); // one live line, kept so screen readers hear its changes
  msg.className = 'msg';
  msg.setAttribute('role', 'status');
  panel.appendChild(view);
  panel.appendChild(msg);
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', panel.id);

  const KEY = 'compound:wallet';
  const INSTALL = [
    ['Phantom', 'https://phantom.com'],
    ['Solflare', 'https://solflare.com'],
    ['Backpack', 'https://backpack.app'],
  ];

  const wallets = []; // every registered wallet, in the order it arrived
  const ids = new WeakMap(); // wallet -> small id, to keep focus on the same row across re-renders
  let nextId = 1;
  let current = null; // { wallet, address, off }
  let pending = null; // the wallet a user-started connect is waiting on
  let seq = 0; // bumps on every connect or disconnect, so a late answer from an older request is ignored
  let note = ''; // one short muted line in the panel
  let silentTried = false;
  let announced = '';
  const remembered = load();

  // ---------- storage (the wallet's name only) ----------

  function load() {
    try { return window.localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  function save(name) {
    try {
      if (name) window.localStorage.setItem(KEY, name);
      else window.localStorage.removeItem(KEY);
    } catch (e) { /* private mode or blocked storage: nothing to remember */ }
  }

  // ---------- Wallet Standard discovery (the app side of the protocol) ----------

  function isSolanaChain(c) { return typeof c === 'string' && c.indexOf('solana:') === 0; }

  function usable(w) {
    try {
      const f = w.features || {};
      return Array.isArray(w.chains) && w.chains.some(isSolanaChain) &&
        !!f['standard:connect'] && typeof f['standard:connect'].connect === 'function';
    } catch (e) { return false; }
  }

  function solanaAccounts(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((a) => a && typeof a.address === 'string' && a.address &&
      (!Array.isArray(a.chains) || a.chains.length === 0 || a.chains.some(isSolanaChain)));
  }

  function accountsOf(w) {
    try { return solanaAccounts(w.accounts); } catch (e) { return []; }
  }

  function register(...list) {
    const added = [];
    for (const w of list) {
      if (!w || typeof w !== 'object' || wallets.indexOf(w) >= 0) continue;
      wallets.push(w);
      ids.set(w, nextId++);
      added.push(w);
    }
    if (added.length) arrived(added);
    return function unregister() {
      let changed = false;
      for (const w of added) {
        const i = wallets.indexOf(w);
        if (i < 0) continue;
        wallets.splice(i, 1);
        changed = true;
        if (current && current.wallet === w) drop();
        if (pending === w) { pending = null; seq++; }
      }
      if (changed) { announce(); render(); }
    };
  }

  const api = Object.freeze({ register });

  window.addEventListener('wallet-standard:register-wallet', (e) => {
    const callback = e && e.detail;
    if (typeof callback !== 'function') return;
    try { callback(api); } catch (err) { /* a broken wallet must not break the page */ }
  });
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch (err) { /* very old browser: no wallets */ }

  function arrived(added) {
    if (!current && !pending && !silentTried && remembered) {
      const w = added.find((x) => usable(x) && x.name === remembered);
      if (w) reconnect(w);
    }
    render();
  }

  // ---------- connect, follow, disconnect ----------

  // On load, only for the wallet used last time, and only without a prompt.
  async function reconnect(w) {
    silentTried = true;
    const my = ++seq;
    try {
      let list = accountsOf(w);
      if (!list.length) {
        const out = await w.features['standard:connect'].connect({ silent: true });
        list = solanaAccounts(out && out.accounts);
        if (!list.length) list = accountsOf(w);
      }
      if (my !== seq || current || pending) return;
      if (list.length) adopt(w, list[0]);
    } catch (err) { /* not authorised any more, or locked: stay quiet and disconnected */ }
  }

  async function connectTo(w) {
    const my = ++seq;
    pending = w;
    note = 'Check ' + nameOf(w) + ' to approve.';
    render();
    try {
      const out = await w.features['standard:connect'].connect();
      if (my !== seq) return;
      let list = solanaAccounts(out && out.accounts);
      if (!list.length) list = accountsOf(w);
      if (!list.length) throw new Error('no Solana account');
      pending = null;
      note = '';
      adopt(w, list[0]);
      save(w.name);
      close(true);
    } catch (err) {
      if (my !== seq) return;
      pending = null;
      note = declined(err) ? 'You declined in the wallet.' : "The wallet didn't connect. Try again.";
      render();
    }
  }

  function declined(err) {
    if (!err) return false;
    if (err.code === 4001) return true;
    let text = '';
    try { text = String(err.message || err); } catch (e) { /* unreadable error */ }
    return /reject|denied|declin|cancel/i.test(text);
  }

  function adopt(w, account) {
    drop();
    let off = null;
    try {
      const ev = w.features['standard:events'];
      if (ev && typeof ev.on === 'function') off = ev.on('change', (props) => changed(w, props));
    } catch (err) { /* no events: the address just won't follow account switches */ }
    current = { wallet: w, address: account.address, account, off };
    announce();
    render();
  }

  function changed(w, props) {
    if (!current || current.wallet !== w || !props || !('accounts' in props)) return;
    const list = Array.isArray(props.accounts) ? solanaAccounts(props.accounts) : accountsOf(w);
    if (!list.length) { // disconnected from the wallet's side
      drop();
      announce();
      render();
      return;
    }
    const keep = list.find((a) => a.address === current.address) || list[0];
    current.account = keep;
    if (keep.address !== current.address) {
      current.address = keep.address;
      note = '';
      announce();
      render();
    }
  }

  function drop() {
    if (current && typeof current.off === 'function') {
      try { current.off(); } catch (err) { /* already gone */ }
    }
    current = null;
  }

  async function disconnect() {
    const c = current;
    if (!c) return;
    seq++;
    drop();
    save('');
    note = '';
    announce();
    close(true);
    render();
    try {
      const d = c.wallet.features['standard:disconnect'];
      if (d && typeof d.disconnect === 'function') await d.disconnect();
    } catch (err) { /* the page has let go either way */ }
  }

  function announce() {
    const address = current ? current.address : null;
    const name = current ? nameOf(current.wallet) : null;
    const key = address === null ? '' : name + '\n' + address;
    if (key === announced) return;
    announced = key;
    window.dispatchEvent(new CustomEvent('compound:wallet', { detail: { address, name } }));
  }

  async function copy() {
    const a = current && current.address;
    if (!a) return;
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(a); ok = true; }
    } catch (err) { /* fall back below */ }
    if (!ok) {
      const t = document.createElement('textarea');
      t.value = a;
      t.setAttribute('readonly', '');
      t.setAttribute('aria-hidden', 'true');
      t.style.position = 'fixed';
      t.style.top = '0';
      t.style.left = '-9999px';
      box.appendChild(t); // inside the wallet box, so focusing it does not close the panel
      try { t.select(); ok = document.execCommand('copy'); } catch (err) { ok = false; }
      t.remove();
    }
    note = ok ? 'Address copied.' : "This browser didn't allow copying.";
    render('copy');
  }

  // ---------- signing, for the launch page ----------

  // The chain the wallet is asked to sign for: the launch page sets it from the cluster the server says it runs on.
  let CHAIN = 'solana:devnet';

  function featureOf(name, method) {
    if (!current) return null;
    try {
      const f = current.wallet.features[name];
      return f && typeof f[method] === 'function' ? f : null;
    } catch (err) { return null; }
  }

  // One request to the wallet. Its answer is the first output; a refusal comes back as an error with .rejected.
  async function ask(name, method, transaction) {
    const f = featureOf(name, method);
    if (!f) throw new Error('this wallet has no ' + name);
    const account = accountsOf(current.wallet).find((a) => a.address === current.address) || current.account;
    try {
      const out = await f[method]({ account, transaction, chain: CHAIN });
      const first = Array.isArray(out) ? out[0] : null;
      if (!first) throw new Error('the wallet gave no answer');
      return first;
    } catch (err) {
      if (!declined(err)) throw err;
      const no = new Error('declined in the wallet');
      no.rejected = true;
      throw no;
    }
  }

  window.compoundWallet = Object.freeze({
    current() { return current ? { address: current.address, name: nameOf(current.wallet) } : null; },
    useCluster(name) { CHAIN = name === 'mainnet' ? 'solana:mainnet' : 'solana:devnet'; },
    canSign() { return !!featureOf('solana:signTransaction', 'signTransaction'); },
    canSend() { return !!featureOf('solana:signAndSendTransaction', 'signAndSendTransaction'); },
    async signTransaction(bytes) {
      const out = await ask('solana:signTransaction', 'signTransaction', bytes);
      if (!out.signedTransaction) throw new Error('the wallet returned no transaction');
      return out.signedTransaction;
    },
    async signAndSend(bytes) {
      const out = await ask('solana:signAndSendTransaction', 'signAndSendTransaction', bytes);
      if (!out.signature) throw new Error('the wallet returned no signature');
      return out.signature;
    },
  });

  // ---------- drawing the button and the panel ----------

  function nameOf(w) {
    try { return String(w.name || 'Wallet'); } catch (e) { return 'Wallet'; }
  }

  function short(a) { return a.length > 11 ? a.slice(0, 4) + '...' + a.slice(-4) : a; }

  function iconOf(w) {
    let src = '';
    try { src = String(w.icon || ''); } catch (e) { /* no icon */ }
    if (/^data:image\/(svg\+xml|png|webp|gif|jpeg|jpg)[;,]/i.test(src)) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.width = 16;
      img.height = 16;
      return img;
    }
    const s = document.createElement('span');
    s.className = 'noicon';
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function option(key, label, w, onClick) {
    const b = el('button', 'opt');
    b.type = 'button';
    b.setAttribute('data-k', key);
    if (w) b.appendChild(iconOf(w));
    b.appendChild(el('span', '', label));
    b.addEventListener('click', onClick);
    return b;
  }

  function render(focusKey) {
    if (current) {
      btn.textContent = short(current.address);
      btn.setAttribute('aria-label', 'wallet ' + short(current.address));
    } else {
      btn.textContent = 'connect';
      btn.removeAttribute('aria-label');
    }
    if (panel.hidden) return;

    const had = focusKey || (document.activeElement && view.contains(document.activeElement)
      ? document.activeElement.getAttribute('data-k') : null);
    view.textContent = '';

    if (current) {
      const who = el('p', 'who');
      who.appendChild(iconOf(current.wallet));
      who.appendChild(el('span', '', 'Connected with ' + nameOf(current.wallet) + '.'));
      view.appendChild(who);
      const opts = el('div', 'opts');
      opts.appendChild(option('copy', 'copy address', null, copy));
      opts.appendChild(option('off', 'disconnect', null, disconnect));
      view.appendChild(opts);
    } else {
      const list = wallets.filter(usable);
      if (list.length) {
        const opts = el('div', 'opts');
        for (const w of list) {
          opts.appendChild(option('w' + ids.get(w), nameOf(w), w, () => connectTo(w)));
        }
        view.appendChild(opts);
        view.appendChild(el('p', '', 'Connecting shows your address to this site. Nothing gets signed.'));
      } else {
        view.appendChild(el('p', '', 'No Solana wallet found in this browser.'));
        const opts = el('div', 'opts');
        for (const [name, href] of INSTALL) {
          const a = el('a', 'opt');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.setAttribute('data-k', 'get-' + name);
          a.appendChild(el('span', '', name));
          opts.appendChild(a);
        }
        view.appendChild(opts);
      }
    }

    if (msg.textContent !== note) msg.textContent = note;

    if (had) {
      const again = view.querySelector('[data-k="' + had + '"]') || firstItem();
      if (again) again.focus();
    }
  }

  function firstItem() { return view.querySelector('button, a[href]'); }

  // ---------- open, close, keyboard ----------

  function open(byKeyboard) {
    if (!panel.hidden) return;
    note = '';
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    render();
    if (byKeyboard) {
      const f = firstItem();
      if (f) f.focus();
    }
  }

  function close(focusButton) {
    if (panel.hidden) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    view.textContent = '';
    msg.textContent = '';
    if (focusButton) btn.focus();
  }

  btn.addEventListener('click', (e) => {
    if (panel.hidden) open(e.detail === 0);
    else close(false);
  });

  document.addEventListener('keydown', (e) => {
    if (panel.hidden || (e.key !== 'Escape' && e.key !== 'Esc')) return;
    e.preventDefault();
    close(true);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !box.contains(e.target)) close(false);
  }, true);

  // Tabbing out of the panel closes it. A window blur (a wallet's popup taking focus) does not.
  box.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (!panel.hidden && to && !box.contains(to)) close(false);
  });

  box.hidden = false;
  render();
})();
