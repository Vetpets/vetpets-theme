/* Popup A/B test - rules: snippets/vp-popup-ab.liquid */
(function () {
  var el = document.getElementById('vp-popup-ab-config');
  if (!el || window.VPPopupAB) return;
  var c;
  try { c = JSON.parse(el.textContent); } catch (e) { return; }
  var K = 'vp_popup_ab', TTL = 90 * 864e5, now = Date.now(), ss = null;
  try { ss = sessionStorage; } catch (e) {}
  var ok = function (v) { return v === 'A' || v === 'B' ? v : null; };
  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  function setCookie(v, ms) {
    document.cookie = K + '=' + v + ';max-age=' + Math.round(ms / 1000) + ';path=/;SameSite=Lax;Secure';
  }

  var m = document.cookie.match(/(?:^|; )vp_popup_ab=([AB])(?:;|$)/);
  var ck = m && m[1], lv = ok(ls(K)), ts = parseInt(ls(K + '_ts'), 10) || 0;
  var v = ck || (lv && now - ts < TTL ? lv : null), fresh = !v;
  if (fresh) { v = Math.random() < 0.5 ? 'A' : 'B'; ts = now; setCookie(v, TTL); }
  else if (!ck) setCookie(v, TTL - (now - ts));
  if (lv !== v || !ts) { ls(K, v); ls(K + '_ts', String(ts || now)); }

  var qa = null;
  try {
    var p = new URLSearchParams(location.search).get(K);
    if (p) { p = ok(p.toUpperCase()); if (p) ss.setItem(K + '_qa', p); else ss.removeItem(K + '_qa'); }
    qa = ok(ss.getItem(K + '_qa'));
  } catch (e) {}
  var arm = qa || v;

  function emit(name, props) {
    props = Object.assign({ variant: arm }, props);
    if (qa) props.qa = true;
    try { klaviyo.push(['track', name, props]); } catch (e) {}
    try { (window.dataLayer = window.dataLayer || []).push(Object.assign({ event: name }, props)); } catch (e) {}
    try { Shopify.analytics.publish(name, props); } catch (e) {}
  }
  var api = window.VPPopupAB = { variant: arm, qa: !!qa, emit: emit };

  function suppressed() {
    var raw = ls('vetpets_welcome_popup'), until = parseInt(raw, 10);
    return !!raw && (!until || Date.now() <= until);
  }

  function gate(open) {
    var done = false, t;
    function go() { if (done) return; done = true; clearTimeout(t); removeEventListener('scroll', sc); open(); }
    function sc() {
      var max = (document.documentElement.scrollHeight - innerHeight) || 1;
      if (scrollY / max >= 0.4) go();
    }
    t = setTimeout(go, Math.max(0, 8000 - performance.now()));
    addEventListener('scroll', sc, { passive: true });
    sc();
  }

  function inject() {
    var th = window.Shopify && Shopify.theme || {}, key = K + '_html_' + th.id, html = null;
    try { html = ss.getItem(key); } catch (e) {}
    (html ? Promise.resolve(html) : fetch(c.root + (th.role && th.role !== 'main' ? '?preview_theme_id=' + th.id : ''))
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var r = new DOMParser().parseFromString(t, 'text/html').querySelector('[data-vpp-root]');
        var sec = r && (r.closest('.shopify-section') || r.parentNode);
        if (!sec) throw 0;
        try { ss.setItem(key, sec.outerHTML); } catch (e) {}
        return sec.outerHTML;
      })
    ).then(function (h) {
      if (document.querySelector('[data-vpp-root]')) return;
      if (c.slow) api.gate = gate;
      var box = document.createElement('div');
      box.innerHTML = h;
      var sec = document.body.appendChild(box.firstElementChild);
      [].forEach.call(sec.querySelectorAll('script:not([type])'), function (o) {
        var s = document.createElement('script');
        s.textContent = o.textContent;
        o.parentNode.replaceChild(s, o);
      });
    }).catch(function () {});
  }

  function start() {
    if (fresh) emit('popup_ab_assigned', { variant: v });
    if (c.cart !== arm) {
      fetch(c.cartUpdate + '.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributes: { popup_ab_variant: arm } })
      }).catch(function () {});
    }
    if (arm === 'B' && !c.ex && !document.querySelector('[data-vpp-root]') && !suppressed()) {
      if (window.requestIdleCallback) requestIdleCallback(inject, { timeout: 3000 }); else setTimeout(inject, 1);
    }
  }
  if (document.readyState === 'complete') start(); else addEventListener('load', start);
})();
