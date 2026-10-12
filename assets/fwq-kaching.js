/* =====================================================================
   FreshWipes quiz lander — Kaching bridge (window.FWQK)
   Loaded only by sections/freshwipes-quiz.liquid.

   Kaching Bundles is authoritative for deal, quantity, price, selling plan and free
   gifts. Its real app block and the theme's <product-form> live in #fwq-commerce
   (outside the quiz's React root, never painted). The quiz logic calls this bridge:

     FWQK.prices(i)   -> { one, sub, compare } display strings for bundle i (0|1).
                         From Kaching's own server-rendered deal settings straight away
                         (same A/B bucket Kaching uses), replaced by the price Kaching
                         renders for the active purchase type once its widget is up.
     FWQK.select(i, routine)  drives Kaching's deal bar + Routine Care checkbox.
     FWQK.addToCart() submits the theme product form; Kaching rewrites the request.
                         Clicks before Kaching has rendered are queued, never sent
                         without Kaching's rewrite.
     FWQK.busy(), FWQK.ready(), FWQK.onChange(fn)
   ===================================================================== */
(function () {
  'use strict';
  if (window.FWQK) return;
  var host = document.getElementById('fwq-commerce');
  var root = document.getElementById('freshwipes-quiz');
  if (!host || !root) return;

  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || host).querySelectorAll(sel)); };
  var txt = function (el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
  var J = function (el) { try { return el ? JSON.parse(el.textContent) : null; } catch (e) { return null; } };
  var gid = function (g) { return g ? String(g).split('/').pop() : ''; };
  var IDS = (root.getAttribute('data-deal-ids') || '').split('|');

  var subs = [];
  function emit() { subs.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  /* ---------- 1. prices from Kaching's own config (immediately) ---------- */
  var early = [{}, {}];
  (function () {
    try {
      var mainP = J(host.querySelector('script.kaching-bundles-product[data-main]'));
      var cfg = J(document.getElementById('kaching-bundles-config')) || {};
      var blocks = mainP ? $$('script.kaching-bundles-deal-block-settings[data-product-id="' + mainP.id + '"]').map(J).filter(Boolean) : [];
      if (!blocks.length) return;
      var store; try { localStorage.setItem('fwq_t', '1'); localStorage.removeItem('fwq_t'); store = localStorage; } catch (e) { store = sessionStorage; }
      var sid = store.getItem('kaching_session_id');
      if (!sid) {
        sid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, function (c) { return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16); });
        store.setItem('kaching_session_id', sid);
      }
      var bucket = Math.floor(parseInt(sid.replace(/-/g, '').slice(0, 4), 16) % 256 * 100 / 256);
      var block = blocks.filter(function (b) { var r = b.abTestVariantRange; return r && bucket >= r[0] && bucket < r[1]; })[0] || blocks[0];
      var v = mainP.variants && mainP.variants[0];
      var fmt = cfg.moneyFormat || '';
      var rate = cfg.currencyRate == null ? 1 : +cfg.currencyRate;
      if (!v || rate !== 1 || !/\{\{\s*amount\s*\}\}/.test(fmt)) return; // other markets: wait for Kaching
      var money = function (n) { return fmt.replace(/\{\{\s*amount\s*\}\}/, n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')); };
      IDS.forEach(function (id, i) {
        var b = block.dealBars.filter(function (x) { return x.id === id; })[0];
        if (!b || b.discountType !== 'specific') return;
        var one = +b.discountValue;
        var plan = (v.sellingPlans || []).filter(function (p) { return String(p.id) === gid(b.sellingPlanGid); })[0];
        var sub = plan && v.price ? one * plan.price / v.price : null;
        if (sub != null && block.priceRounding && block.priceRoundingPrecision === '.00') sub = Math.ceil(sub - 1e-9);
        early[i] = { one: money(one), sub: sub != null ? money(sub) : '', compare: (block.useProductCompareAtPrice && v.compareAtPrice) ? money(v.compareAtPrice * b.quantity / 100) : '' };
      });
    } catch (e) {}
  })();

  /* ---------- 2. Kaching's rendered widget ---------- */
  var kBar = function (i) { return host.querySelector('.kaching-bundles__bar[data-deal-bar-id="' + IDS[i] + '"]'); };
  var kSelectedId = function () { var b = host.querySelector('.kaching-bundles__bar--selected[data-deal-bar-id]'); return b ? b.getAttribute('data-deal-bar-id') : null; };
  var kSubBox = function () { return host.querySelector('.kaching-bundles__subscriptions-wrapper [role="checkbox"], .kaching-bundles__subscriptions-wrapper input[data-subscribe]'); };
  var kSubOn = function () { var c = kSubBox(); if (!c) return null; return c.tagName === 'INPUT' ? !!c.checked : c.getAttribute('aria-checked') === 'true'; };
  var clean = function (el) { if (!el) return ''; var c = el.cloneNode(true); $$('.vp-sr', c).forEach(function (n) { n.remove(); }); return txt(c); };
  var kPrice = function (i) { var b = kBar(i); return clean(b && b.querySelector('.kaching-bundles__bar-price')); };
  var kCompare = function (i) { var b = kBar(i); return clean(b && b.querySelector('.kaching-bundles__bar-full-price')); };
  var kReady = function () { return !!(kBar(0) && kBar(1) && kPrice(0) && kPrice(1) && kSubBox()); };

  var want = { tier: 1, routine: true };
  var ready = false, queued = false, pending = false;

  function drive() {
    if (!kReady()) return;
    if (kSelectedId() !== IDS[want.tier]) {
      var bar = kBar(want.tier), input = bar && bar.querySelector('input[type="radio"]');
      (input || bar).click();
    }
    var on = kSubOn();
    if (on !== null && on !== want.routine) kSubBox().click();
  }
  function inSync() { return kReady() && kSelectedId() === IDS[want.tier] && kSubOn() === want.routine; }

  var syncT;
  function onKaching() {
    clearTimeout(syncT);
    syncT = setTimeout(function () {
      if (!kReady()) return;
      if (!ready) {
        ready = true;
        root.setAttribute('data-kaching', 'ready');
        $$('input, button, a, [tabindex]').forEach(function (el) { el.setAttribute('tabindex', '-1'); });
      }
      drive();
      emit();
      if (queued && inSync()) { queued = false; submit(); }
    }, 60);
  }
  if ('MutationObserver' in window) new MutationObserver(onKaching).observe(host, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-checked', 'checked'] });
  onKaching();
  window.addEventListener('load', onKaching);

  /* ---------- 3. the one add-to-cart path ---------- */
  function form() { return host.querySelector('form[action*="/cart/add"]'); }
  function release() { pending = false; emit(); }
  function watchDrawer() {
    var drawer = document.querySelector('cart-drawer');
    if (!drawer) { setTimeout(release, 4000); return; }
    var done = false;
    var obs = new MutationObserver(function () { if (drawer.classList.contains('active') || drawer.classList.contains('is-open')) finish(); });
    function finish() { if (done) return; done = true; obs.disconnect(); release(); }
    obs.observe(drawer, { attributes: true, attributeFilter: ['class'] });
    setTimeout(finish, 8000);
  }
  var tries = 0;
  function submit() {
    var f = form(), b = f && f.querySelector('[name="add"]');
    if (!f || !b) return;
    if (!inSync()) {
      drive();
      if (tries++ < 6) { setTimeout(submit, 400); } else { tries = 0; pending = false; emit(); }
      return;
    }
    tries = 0;
    pending = true; emit();
    if (typeof f.requestSubmit === 'function') f.requestSubmit(b); else b.click();
    watchDrawer();
  }

  window.FWQK = {
    prices: function (i) {
      var e = early[i] || {};
      // Kaching renders every bar's price for its current purchase type
      var live = ready && kSubOn() === want.routine ? kPrice(i) : '';
      return {
        one: (!want.routine && live) || e.one || '',
        sub: (want.routine && live) || e.sub || '',
        compare: (ready && kCompare(i)) || e.compare || ''
      };
    },
    select: function (i, routine) {
      var t = i === 0 ? 0 : 1, r = !!routine;
      if (want.tier === t && want.routine === r) return;
      want.tier = t; want.routine = r; drive();
    },
    addToCart: function () {
      if (pending) return;
      if (!ready) { queued = true; pending = true; emit(); return; }
      submit();
    },
    busy: function () { return pending || queued; },
    ready: function () { return ready; },
    onChange: function (fn) { subs.push(fn); }
  };
  emit();
})();
