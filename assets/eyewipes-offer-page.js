/*
  EyeWipes offer page — scoped behaviour
  -------------------------------------
  Everything is queried inside #eyewipes-offer-page and nothing is written to
  the global scope.

  Kaching Bundles owns the commerce state. This file NEVER sets a tier, a
  quantity, a selling plan or a cart payload — it only OBSERVES Kaching's own
  DOM (selected bar, free-gift rows) and the one authoritative product form
  (selling_plan / quantity / id) and reflects that state into the gallery,
  badges, CTA labels and the sticky bar.

  The only writes are presentational: data-attributes, label text, image src,
  and one injected gift-toggle button per tier.
*/
(function () {
  'use strict';

  var root = document.getElementById('eyewipes-offer-page');
  if (!root) return;

  var cfgEl = document.getElementById('ewof-config');
  var CFG = {};
  try { CFG = JSON.parse(cfgEl.textContent); } catch (e) { CFG = {}; }
  var TIERS = CFG.tiers || [];
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var $ = function (sel, ctx) { return (ctx || root).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || root).querySelectorAll(sel)); };

  /* ---------------------------------------------------------------
     1. countdown
     --------------------------------------------------------------- */
  (function countdown() {
    var h = $('#ewof-cd-h'), m = $('#ewof-cd-m'), s = $('#ewof-cd-s');
    if (!h || !m || !s) return;
    var left = parseInt(root.getAttribute('data-cd-seconds'), 10);
    if (!(left > 0)) left = 11 * 3600 + 32 * 60 + 45;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var tick = function () {
      h.textContent = pad(Math.floor(left / 3600));
      m.textContent = pad(Math.floor((left % 3600) / 60));
      s.textContent = pad(left % 60);
      left = left > 0 ? left - 1 : 86399;
    };
    tick();
    setInterval(tick, 1000);
  })();

  /* ---------------------------------------------------------------
     2. gallery
     --------------------------------------------------------------- */
  var rail = $('#ewof-rail');
  var slideCount = rail ? $$('.slide', rail).length : 0;
  var current = 0;

  function scrollRail(i) {
    if (!rail) return;
    var from = rail.scrollLeft;
    var to = rail.clientWidth * i;
    if (Math.abs(to - from) < 2) return;
    if (reduceMotion) { rail.scrollLeft = to; return; }
    var t0 = 0;
    var step = function (ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / 260);
      rail.scrollLeft = from + (to - from) * (1 - Math.pow(1 - p, 3));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function paintGallery(i) {
    current = i;
    $$('.dot').forEach(function (d, n) { d.classList.toggle('on', n === i); });
    $$('.thumb').forEach(function (t, n) {
      t.classList.toggle('on', n === i);
      t.setAttribute('aria-selected', n === i ? 'true' : 'false');
    });
    var badges = $('.g-badges');
    if (badges) badges.classList.toggle('off', i !== 0);
    var p = $('.navbtn-p'), n2 = $('.navbtn-n');
    if (p) p.disabled = i <= 0;
    if (n2) n2.disabled = i >= slideCount - 1;
    var row = $('.thumbs');
    if (row && row.children[i]) {
      var b = row.children[i];
      row.scrollLeft = Math.max(0, b.offsetLeft - (row.clientWidth - b.offsetWidth) / 2);
    }
  }

  function goTo(i) {
    i = Math.max(0, Math.min(slideCount - 1, i));
    scrollRail(i);
    paintGallery(i);
  }

  if (rail) {
    var railTick = null;
    rail.addEventListener('scroll', function () {
      if (railTick) return;
      railTick = requestAnimationFrame(function () {
        railTick = null;
        var i = Math.round(rail.scrollLeft / rail.clientWidth);
        if (i !== current) paintGallery(i);
      });
    }, { passive: true });
    rail.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); goTo(current + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(current - 1); }
    });
  }
  $$('.dot').forEach(function (d, i) { d.addEventListener('click', function () { goTo(i); }); });
  $$('.thumb').forEach(function (t, i) { t.addEventListener('click', function () { goTo(i); }); });
  var pBtn = $('.navbtn-p'), nBtn = $('.navbtn-n');
  if (pBtn) pBtn.addEventListener('click', function () { goTo(current - 1); });
  if (nBtn) nBtn.addEventListener('click', function () { goTo(current + 1); });
  paintGallery(0);

  /* ---------------------------------------------------------------
     3. information tabs
     --------------------------------------------------------------- */
  var tabs = $$('.info-tab');
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t, n) {
        t.classList.toggle('on', n === i);
        t.setAttribute('aria-selected', n === i ? 'true' : 'false');
      });
      $$('.info-panel').forEach(function (p, n) { p.hidden = n !== i; });
    });
  });

  /* ---------------------------------------------------------------
     4. FAQ accordion
     --------------------------------------------------------------- */
  $$('.faq-q').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var row = btn.closest('.faq-row');
      var wrap = row.querySelector('.faq-wrap');
      var ic = row.querySelector('.faq-ic');
      var open = btn.getAttribute('aria-expanded') === 'true';
      $$('.faq-row').forEach(function (r) {
        r.classList.remove('on');
        r.querySelector('.faq-wrap').classList.remove('on');
        r.querySelector('.faq-ic').classList.remove('on');
        r.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
      });
      if (!open) {
        row.classList.add('on');
        wrap.classList.add('on');
        ic.classList.add('on');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  /* ===============================================================
     5. KACHING OBSERVATION
     Kaching is authoritative. We read, we never set commerce state.
     =============================================================== */
  var kBlock = function () { return document.querySelector('#eyewipes-offer-page .kaching-bundles__block'); };
  var theForm = function () {
    var host = $('.ewof-form-host');
    return host ? host.querySelector('form[action*="/cart/add"]') : null;
  };
  var submitBtn = function () {
    var f = theForm();
    return f ? f.querySelector('[name="add"]') : null;
  };

  function fieldValue(name) {
    var f = theForm();
    if (!f) return null;
    var i = f.querySelector('[name="' + name + '"]');
    return i && i.value ? i.value : null;
  }

  function selectedBar() {
    return document.querySelector('#eyewipes-offer-page .kaching-bundles__bar--selected');
  }

  function tierForBar(bar) {
    if (!bar) return null;
    var id = bar.getAttribute('data-deal-bar-id');
    for (var i = 0; i < TIERS.length; i++) if (TIERS[i].deal_id === id) return TIERS[i];
    // fall back to DOM order so a changed deal id degrades gracefully
    var bars = $$('.kaching-bundles__bar[data-deal-bar-id]');
    var idx = bars.indexOf(bar);
    return idx > -1 && TIERS[idx] ? TIERS[idx] : null;
  }

  /* label each free-gift row so CSS can collapse real product gifts, and
     inject one truthful toggle per tier: the count comes from Kaching. */
  function decorateGifts() {
    $$('.kaching-bundles__bar[data-deal-bar-id]').forEach(function (bar) {
      var container = bar.querySelector('.kaching-bundles__bar-container');
      if (!container) return;
      var gifts = Array.prototype.slice.call(bar.querySelectorAll('.kaching-bundles__free-gift'));
      var product = gifts.filter(function (g) {
        return !!g.querySelector('.kaching-bundles__free-gift__full-price');
      });
      product.forEach(function (g) { g.setAttribute('data-ewof-gift', 'product'); });

      var existing = bar.querySelector('.ewof-gift-toggle');
      if (!product.length) { if (existing) existing.remove(); return; }

      var label = '+ ' + product.length + ' Free Gift' + (product.length === 1 ? '' : 's');
      if (existing) {
        existing.querySelector('.ewof-gift-label').textContent = label;
        return;
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ewof-gift-toggle';
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<rect x="3" y="9.5" width="18" height="11.5" rx="1.8" fill="#47B5E9"></rect>' +
        '<rect x="2" y="6" width="20" height="4.5" rx="1.5" fill="#2E9FD8"></rect>' +
        '<path d="M12 6v15" stroke="#FFFFFF" stroke-width="1.8"></path></svg>' +
        '<span class="ewof-gift-label"></span>' +
        '<svg class="ewof-caret" width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="m6 9.5 6 6 6-6" stroke="#1F7FB8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
      btn.querySelector('.ewof-gift-label').textContent = label;
      btn.addEventListener('click', function (e) {
        // the toggle sits inside Kaching's <label>; stop it from re-triggering the radio
        e.preventDefault();
        e.stopPropagation();
        var open = bar.getAttribute('data-ewof-gifts') === 'open';
        bar.setAttribute('data-ewof-gifts', open ? 'closed' : 'open');
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
      // place it directly after the shipping perk row, before the gift rows
      var firstGift = product[0];
      firstGift.parentNode.insertBefore(btn, firstGift);
    });
  }

  /* teal "discount applied" line, and the RoutineCare free-shipping note */
  function decorateStatics() {
    $$('.kaching-bundles__bar[data-deal-bar-id]').forEach(function (bar) {
      var tier = tierForBar(bar);
      if (!tier || !tier.applied_label) return;
      if (bar.querySelector('.ewof-applied')) {
        bar.querySelector('.ewof-applied span').textContent = tier.applied_label;
        return;
      }
      var d = document.createElement('div');
      d.className = 'ewof-applied';
      d.innerHTML =
        '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="9.5" fill="#13B6B5"></circle>' +
        '<path d="m7.5 12.2 3 3 6-6.4" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"></path></svg><span></span>';
      d.querySelector('span').textContent = tier.applied_label;
      bar.appendChild(d);
    });

    // The note belongs under the subtitle, inside Kaching's text column — as a
    // sibling of the card it became a flex item and floated to the bottom-right.
    var col = document.querySelector('#eyewipes-offer-page .kaching-bundles__subscriptions .kaching-bundles__bar-content-left');
    if (col && CFG.rc_note) {
      var stale = document.querySelector('#eyewipes-offer-page .kaching-bundles__subscriptions__card > .ewof-rc-note');
      if (stale) stale.remove();
      if (!col.querySelector('.ewof-rc-note')) {
        var n = document.createElement('span');
        n.className = 'ewof-rc-note';
        n.textContent = CFG.rc_note;
        col.appendChild(n);
      }
    }
  }

  /* read Kaching + the authoritative form, then repaint presentation.
     Guarded by a cheap state signature so repeated observer hits during a
     cart request do no DOM work. */
  var lastSig = null;
  function sync() {
    var barNow = selectedBar();
    var sig = (barNow ? barNow.getAttribute('data-deal-bar-id') : '-') + '|' +
      (fieldValue('selling_plan') || '-') + '|' + (fieldValue('quantity') || '-') + '|' +
      (barNow ? barNow.querySelectorAll('.kaching-bundles__free-gift').length : 0);
    if (sig === lastSig) return;
    lastSig = sig;

    decorateGifts();
    decorateStatics();
    var bar = barNow;
    var tier = tierForBar(bar);
    var plan = fieldValue('selling_plan');
    var rcOn = !!plan;

    root.setAttribute('data-rc', rcOn ? 'on' : 'off');
    if (tier) root.setAttribute('data-tier', tier.key);

    // price straight from Kaching's own selected bar
    var priceEl = bar && bar.querySelector('.kaching-bundles__bar-pricing > *');
    var price = priceEl ? priceEl.textContent.trim() : '';

    // hero image + thumbnails follow the tier
    if (tier) {
      var hero = $('#ewof-tier-img');
      if (hero && hero.getAttribute('src') !== tier.image) {
        hero.setAttribute('src', tier.image);
        hero.setAttribute('alt', tier.image_alt || '');
      }
      $$('[data-ewof-tier-thumb]').forEach(function (img) {
        if (img.getAttribute('src') !== tier.image) img.setAttribute('src', tier.image);
      });
      // the offer pill may only claim gifts Kaching actually adds
      var giftCount = bar
        ? bar.querySelectorAll('.kaching-bundles__free-gift[data-ewof-gift="product"]').length
        : 0;
      var pill = $('.g-pill');
      if (pill) {
        pill.textContent = giftCount
          ? tier.badge + ' + ' + giftCount + ' Free Gift' + (giftCount === 1 ? '' : 's')
          : tier.badge;
      }
      var pill2 = $('.g-pill2');
      if (pill2) {
        pill2.textContent = tier.pill || '';
        pill2.hidden = !tier.pill;
      }
      $$('[data-ewof-cta-label]').forEach(function (el) { el.textContent = tier.cta; });
      var so = $('.sticky-offer');
      if (so) so.textContent = tier.name;
    }

    var sp = $('.sticky-price');
    if (sp) sp.textContent = price;
    var rcChip = $('.sticky-rc');
    if (rcChip) rcChip.hidden = !rcOn;

  }

  /* Kaching re-renders its block and rewrites the form inputs asynchronously
     after every interaction, and it does not emit a public event. We therefore
     re-read its state on a short settle ladder after any signal, rather than
     polling continuously: the ladder stops on its own and there is no interval. */
  var syncTimer = null;
  function queueSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () { syncTimer = null; sync(); }, 0);
  }
  var ladder = [];
  function settleSync() {
    ladder.forEach(clearTimeout);
    ladder = [80, 350, 900, 1800].map(function (d) { return setTimeout(sync, d); });
    queueSync();
  }

  var mo = new MutationObserver(queueSync);
  mo.observe(root, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'data-deal-bar-id', 'value']
  });
  // Kaching's radios and its subscription card are the real controls; listening
  // in the capture phase means we see them whatever Kaching does downstream.
  root.addEventListener('change', settleSync, true);
  root.addEventListener('click', function (e) {
    // An add-to-cart click cannot change Kaching's selection, so skip the
    // settle ladder entirely — it would otherwise run four full DOM passes
    // while the cart request and drawer render are competing for the main thread.
    if (e.target.closest && e.target.closest('[data-ewof-submit], [name="add"]')) return;
    settleSync();
  }, true);
  document.addEventListener('visibilitychange', queueSync);
  settleSync();
  window.addEventListener('load', settleSync);

  /* ---------------------------------------------------------------
     6. one authoritative add-to-cart path
     --------------------------------------------------------------- */
  var pending = false;

  function releaseButtons() {
    pending = false;
    $$('[data-ewof-submit]').forEach(function (b) { b.disabled = false; b.removeAttribute('aria-busy'); });
  }

  function showError(msg) {
    var w = $('.ewof-form-host .product-form__error-message-wrapper');
    if (!w) { return; }
    var t = w.querySelector('.product-form__error-message');
    if (t) t.textContent = msg;
    w.hidden = false;
  }

  function submitAuthoritativeForm() {
    if (pending) return;
    var f = theForm();
    var b = submitBtn();
    if (!f || !b) { showError(CFG.error_text || 'Something went wrong. Please refresh and try again.'); return; }
    pending = true;
    $$('[data-ewof-submit]').forEach(function (x) { x.disabled = true; x.setAttribute('aria-busy', 'true'); });
    var w = $('.ewof-form-host .product-form__error-message-wrapper');
    if (w) w.hidden = true;

    // requestSubmit fires the submit event the theme's <product-form> listens for
    if (typeof f.requestSubmit === 'function') f.requestSubmit(b);
    else b.click();

    watchForDrawer();
  }

  // Release the CTAs the moment the theme's own drawer opens — no fixed delay.
  function watchForDrawer() {
    var drawer = document.querySelector('cart-drawer');
    if (!drawer) { setTimeout(releaseButtons, 4000); return; }
    var done = false;
    var finish = function () { if (done) return; done = true; obs.disconnect(); releaseButtons(); };
    var obs = new MutationObserver(function () {
      if (drawer.classList.contains('active') || drawer.classList.contains('is-open')) finish();
    });
    obs.observe(drawer, { attributes: true, attributeFilter: ['class'] });
    setTimeout(finish, 8000);
  }

  // the sticky and final CTAs are proxies for the one real form
  $$('[data-ewof-submit]').forEach(function (btn) {
    if (btn.closest('.ewof-form-host')) return; // the real submit button submits itself
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      submitAuthoritativeForm();
    });
  });

  // the real submit button is inside the form; just guard double taps
  var realBtn = submitBtn();
  if (realBtn) {
    realBtn.addEventListener('click', function (e) {
      if (pending) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      pending = true;
      // Disabling on a later task so this click still produces the submit event.
      setTimeout(function () {
        $$('[data-ewof-submit]').forEach(function (x) { x.disabled = true; x.setAttribute('aria-busy', 'true'); });
      }, 0);
      watchForDrawer();
    });
  }

  /* ---------------------------------------------------------------
     7. sticky bar — genuinely viewport-fixed. Shown once the hero purchase
     controls have scrolled out, hidden again before the footer.
     --------------------------------------------------------------- */
  var sticky = $('.ewof-sticky');
  var anchor = $('.ewof-form-host');
  var footer = $('.foot');

  function paintSticky() {
    if (!sticky || !anchor) return;
    var a = anchor.getBoundingClientRect();
    var pastHero = a.bottom <= 0;
    var beforeFooter = true;
    if (footer) beforeFooter = footer.getBoundingClientRect().top > window.innerHeight;
    sticky.classList.toggle('show', pastHero && beforeFooter);
  }

  var stickyTick = false;
  function onScroll() {
    if (stickyTick) return;
    stickyTick = true;
    requestAnimationFrame(function () { stickyTick = false; paintSticky(); });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  window.addEventListener('load', paintSticky);
  paintSticky();
})();
