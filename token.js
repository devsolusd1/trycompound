// The Compound token's block, on every page: the copy button for its CA, and where the page has a #tok-mc line (the
// home page), its market cap in dollars from /api/coins. Nothing else; no libraries.
(function () {
  'use strict';

  Array.prototype.forEach.call(document.querySelectorAll('.tok [data-copy]'), (button) => {
    const word = button.textContent;
    let timer = 0;
    const said = (text) => { button.textContent = text; clearTimeout(timer); timer = setTimeout(() => { button.textContent = word; }, 1600); };
    button.addEventListener('click', () => {
      const text = button.getAttribute('data-copy');
      const fallback = () => {
        try {
          const t = document.createElement('textarea');
          t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
          document.body.appendChild(t); t.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(t);
          said(ok ? 'copied' : 'copy failed');
        } catch (err) { said('copy failed'); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => said('copied'), fallback);
      else fallback();
    });
  });

  const mc = document.getElementById('tok-mc');
  if (!mc || !window.fetch) return;
  const dollars = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : Math.round(n).toString());
  fetch('/api/coins', { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const t = j && j.token, usd = j && Number(j.solUsd);
      if (!t || t.test || !(t.marketCapSol > 0) || !(usd > 0)) return;
      mc.textContent = 'Market cap about $' + dollars(t.marketCapSol * usd) + (t.state === 'graduated' ? ', in its Meteora pool.' : ', on its curve.');
      mc.hidden = false;
    })
    .catch(() => {});
})();
