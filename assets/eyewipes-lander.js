/* =====================================================================
   EyeWipes lander — behaviour
   Loaded only by sections/eyewipes-lander.liquid. Ports the approved Claude
   Design component logic ("EyeWipes Listicle - 3 remedies v2") to vanilla JS.

   COMMERCE: Kaching Bundles is authoritative. The approved picker never builds
   a cart payload and never authors a price. It:
     - selects the matching Kaching deal bar and toggles Kaching's own
       Routine Care checkbox,
     - reads each bar's price / compare-at price back from Kaching's DOM,
     - checks the approved gift rows against the gifts Kaching renders and
       falls back to Kaching's own rows if they differ,
     - lets the theme's <product-form> submit; Kaching rewrites the request
       (quantity, selling plan, gift lines) and the theme opens the cart drawer.
   ===================================================================== */
(function () {
  'use strict';

  var root = document.getElementById('eyewipes-lander');
  if (!root) return;

  var $ = function (sel, ctx) { return (ctx || root).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || root).querySelectorAll(sel)); };
  var reduce = function () { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); };

  var DEAL_IDS = (root.getAttribute('data-deal-ids') || '').split('|');
  var state = { tier: 1, routine: true, hoverTier: null, focusTier: null, gal: 0 };

  /* ---------------------------------------------------------------
     1. Kaching access
     --------------------------------------------------------------- */
  var kHost = $('.ewld-kaching');
  function kBar(i) {
    return kHost ? kHost.querySelector('.kaching-bundles__bar[data-deal-bar-id="' + DEAL_IDS[i] + '"]') : null;
  }
  function kSelectedId() {
    var b = kHost && kHost.querySelector('.kaching-bundles__bar--selected[data-deal-bar-id]');
    return b ? b.getAttribute('data-deal-bar-id') : null;
  }
  function kSubBox() {
    return kHost ? kHost.querySelector('.kaching-bundles__subscriptions-wrapper [role="checkbox"]') : null;
  }
  function kSubOn() {
    var c = kSubBox();
    return c ? c.getAttribute('aria-checked') === 'true' : null;
  }
  function txt(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function kPrice(i) { var b = kBar(i); return txt(b && b.querySelector('.kaching-bundles__bar-price')); }
  function kCompare(i) { var b = kBar(i); return txt(b && b.querySelector('.kaching-bundles__bar-full-price')); }
  function kGiftRows(i) {
    var b = kBar(i);
    return b ? $$('.kaching-bundles__free-gift', b) : [];
  }
  function kReady() { return !!(kBar(0) && kBar(1) && kPrice(0) && kPrice(1) && kSubBox()); }

  /* push the picker state into Kaching's own controls */
  function driveKaching() {
    if (!kReady()) return;
    var want = DEAL_IDS[state.tier];
    if (kSelectedId() !== want) {
      var bar = kBar(state.tier);
      var input = bar && bar.querySelector('input[type="radio"]');
      (input || bar).click();
    }
    var on = kSubOn();
    if (on !== null && on !== state.routine) kSubBox().click();
  }
  function inSync() {
    return kReady() && kSelectedId() === DEAL_IDS[state.tier] && kSubOn() === state.routine;
  }

  /* ---------------------------------------------------------------
     2. Which offer is Kaching serving? (Kaching runs its own A/B test on this
        deal block.) The authored picker content is the approved offer; it is
        shown only when Kaching's bars match it — same bundle title and the same
        free gifts. Otherwise every variant-specific slot is filled from
        Kaching's own bar, so each A/B arm shows exactly its own offer.
     --------------------------------------------------------------- */
  var APPROVED_TITLE = 'the clear eyes transformation kit';
  var GIFT_RX = { comb: /comb/i, guide: /guide|e-?book/i, tracker: /tracker/i, ship: /shipping/i };
  function kField(i, sel) { var b = kBar(i); return txt(b && b.querySelector(sel)); }
  function giftText(row) {
    var t = row.querySelector('.kaching-bundles__free-gift__text');
    return txt(t || row).replace(/\s*[$€£]\s?[\d.,]+\s*$|\s*[\d.,]+\s?(kr|SEK|DKK|NOK)\s*$/i, '');
  }
  function matchesApproved(tierEl, i) {
    if (kField(i, '.kaching-bundles__bar-title').toLowerCase() !== APPROVED_TITLE) return false;
    var keys = (tierEl.getAttribute('data-gift-keys') || '').split(',').filter(function (k) { return k && k !== 'ship'; });
    var rows = kGiftRows(i).map(giftText).filter(function (r) { return !GIFT_RX.ship.test(r); });
    if (rows.length !== keys.length) return false;
    var used = [];
    return keys.every(function (k) {
      for (var n = 0; n < rows.length; n++) {
        if (used.indexOf(n) === -1 && GIFT_RX[k].test(rows[n])) { used.push(n); return true; }
      }
      return false;
    });
  }
  var lastSig = '';
  function fillFromKaching(el, i) {
    var bar = kBar(i);
    var set = function (sel, v) { var n = el.querySelector(sel); if (n) n.textContent = v; };
    set('[data-ewld-title]', kField(i, '.kaching-bundles__bar-title'));
    set('[data-ewld-sub]', kField(i, '.kaching-bundles__bar-label'));
    set('[data-ewld-badge]', kField(i, '.kaching-bundles__bar-most-popular__content'));
    set('[data-ewld-tagline]', kField(i, '.kaching-bundles__bar-subtitle'));
    var kImg = bar && bar.querySelector('.kaching-bundles__bar-image');
    if (kImg && kImg.src && kImg.src.indexOf('data:') !== 0) {
      el.setAttribute('data-img', kImg.src);
      el.setAttribute('data-alt', kField(i, '.kaching-bundles__bar-title') + ' — ' + kField(i, '.kaching-bundles__bar-label'));
      var ti = el.querySelector('[data-ewld-tier-img]');
      if (ti) ti.src = kImg.src;
    }
    var rows = kGiftRows(i);
    var products = rows.filter(function (r) { return !GIFT_RX.ship.test(giftText(r)); }).length;
    set('[data-ewld-gift-badge]', products ? '🎁 +' + products + ' FREE gift' + (products === 1 ? '' : 's') : '');
    var gb = el.querySelector('[data-ewld-gift-badge]');
    if (gb) gb.style.display = products ? '' : 'none';
    var list = el.querySelector('[data-ewld-gift-list]');
    if (list) {
      list.innerHTML = '';
      rows.forEach(function (r) {
        var row = document.createElement('span');
        row.style.cssText = 'display:flex;align-items:center;gap:10px';
        var box = document.createElement('span');
        box.style.cssText = 'width:38px;height:38px;border-radius:9px;overflow:hidden;background:#FFFFFF;border:1px solid rgba(71,181,233,.25);display:flex;align-items:center;justify-content:center;flex-shrink:0';
        var gi = r.querySelector('.kaching-bundles__free-gift__image');
        if (gi && gi.src && gi.src.indexOf('data:') !== 0) {
          var img = document.createElement('img');
          img.src = gi.src; img.alt = ''; img.loading = 'lazy';
          img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
          box.appendChild(img);
        }
        var col = document.createElement('span');
        col.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:1px';
        var lab = document.createElement('span');
        lab.style.cssText = 'font-size:13.5px;font-weight:700;line-height:1.3';
        lab.textContent = giftText(r).replace(/^\+\s*/, '');
        col.appendChild(lab);
        row.appendChild(box); row.appendChild(col);
        list.appendChild(row);
      });
      list.style.display = rows.length ? '' : 'none';
    }
    el.setAttribute('data-cta', 'Add to cart →');
  }
  function applyOfferMode() {
    var approved = tiers.every(function (el) { return matchesApproved(el, +el.getAttribute('data-ewld-tier')); });
    if (approved) {
      if (root.getAttribute('data-offer') !== 'approved') root.setAttribute('data-offer', 'approved');
      return;
    }
    var sig = tiers.map(function (el) {
      var i = +el.getAttribute('data-ewld-tier');
      var b = kBar(i);
      var imgs = b ? $$('img', b).map(function (im) { return im.getAttribute('src') || ''; }).join(',') : '';
      return kField(i, '.kaching-bundles__bar-title') + kField(i, '.kaching-bundles__bar-label') + kField(i, '.kaching-bundles__bar-most-popular__content') + kGiftRows(i).map(giftText).join(',') + imgs;
    }).join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      tiers.forEach(function (el) { fillFromKaching(el, +el.getAttribute('data-ewld-tier')); });
    }
    root.setAttribute('data-offer', 'kaching');
  }

  /* ---------------------------------------------------------------
     3. Paint the picker from state + Kaching
     --------------------------------------------------------------- */
  var tiers = $$('[data-ewld-tier]');
  var routineBtn = $('[data-ewld-routine]');
  var atc = $('[data-ewld-atc]');
  var ctaLabel = $('[data-ewld-cta-label]');
  var galMain = $('[data-ewld-gal-main]');
  var thumbs = $$('[data-ewld-thumb]');
  var disclosure = $('[data-pfd-disclosure]');
  var ready = false;

  function paint() {
    tiers.forEach(function (el) {
      var i = +el.getAttribute('data-ewld-tier');
      var sel = i === state.tier;
      var preview = el.hasAttribute('data-preview-on-hover') && (state.hoverTier === i || state.focusTier === i);
      el.setAttribute('aria-checked', sel ? 'true' : 'false');
      el.setAttribute('aria-expanded', sel || preview ? 'true' : 'false');
      var p = el.querySelector('[data-ewld-price]');
      var c = el.querySelector('[data-ewld-compare]');
      if (p) p.textContent = kPrice(i);
      if (c) c.textContent = kCompare(i);
    });
    if (routineBtn) routineBtn.setAttribute('aria-checked', state.routine ? 'true' : 'false');
    root.setAttribute('data-tier', String(state.tier));
    root.setAttribute('data-routine', state.routine ? 'on' : 'off');

    var t = tiers.filter(function (el) { return +el.getAttribute('data-ewld-tier') === state.tier; })[0];
    if (t) {
      if (ctaLabel) ctaLabel.textContent = t.getAttribute('data-cta');
      // gallery: slot 0 is always the selected bundle image
      if (thumbs[0]) {
        thumbs[0].setAttribute('data-src', t.getAttribute('data-img'));
        thumbs[0].setAttribute('data-alt', t.getAttribute('data-alt'));
        thumbs[0].setAttribute('aria-label', t.getAttribute('data-alt'));
        var ti = thumbs[0].querySelector('img');
        if (ti && ti.getAttribute('src') !== t.getAttribute('data-img')) ti.setAttribute('src', t.getAttribute('data-img'));
      }
    }
    thumbs.forEach(function (b, n) { b.setAttribute('aria-selected', n === state.gal ? 'true' : 'false'); });
    var g = thumbs[state.gal];
    if (galMain && g && galMain.getAttribute('src') !== g.getAttribute('data-src')) {
      galMain.setAttribute('src', g.getAttribute('data-src'));
      galMain.setAttribute('alt', g.getAttribute('data-alt'));
    }

    if (atc) {
      atc.setAttribute('data-bundle', 'bundle-' + (state.tier + 1));
      atc.setAttribute('data-price', kPrice(state.tier).replace(/[^\d.,]/g, ''));
      atc.setAttribute('data-purchase-type', state.routine ? 'subscription' : 'one-time');
      atc.setAttribute('data-selling-plan', state.routine ? sellingPlanField() : '');
      if (ready && !pending) { atc.disabled = false; atc.removeAttribute('aria-busy'); }
    }
    // PayFac disclosure: only while Routine Care is on, amounts straight from Kaching's bar
    if (disclosure) {
      disclosure.hidden = !state.routine || !kPrice(state.tier);
      var today = disclosure.querySelector('[data-pfd-today]');
      var rec = disclosure.querySelector('[data-pfd-recurring]');
      if (today) today.textContent = kPrice(state.tier);
      if (rec) rec.textContent = kPrice(state.tier);
    }
  }

  function sellingPlanField() {
    var f = theForm();
    var el = f && f.querySelector('[name="selling_plan"]');
    return el && el.value ? el.value : '';
  }

  /* picker events */
  tiers.forEach(function (el) {
    var i = +el.getAttribute('data-ewld-tier');
    el.addEventListener('click', function () {
      state.tier = i; state.gal = 0; paint(); driveKaching();
    });
    if (el.hasAttribute('data-preview-on-hover')) {
      el.addEventListener('pointerenter', function (e) { if (!e || e.pointerType === 'mouse') { state.hoverTier = i; paint(); } });
      el.addEventListener('pointerleave', function () { if (state.hoverTier === i) { state.hoverTier = null; paint(); } });
      el.addEventListener('focus', function () { state.focusTier = i; paint(); });
      el.addEventListener('blur', function () { if (state.focusTier === i) { state.focusTier = null; paint(); } });
    }
  });
  if (routineBtn) routineBtn.addEventListener('click', function () {
    state.routine = !state.routine; paint(); driveKaching();
  });
  thumbs.forEach(function (b, n) {
    b.addEventListener('click', function () { state.gal = n; paint(); });
  });

  /* Kaching renders asynchronously and re-renders on every change */
  var syncT;
  function onKachingChange() {
    clearTimeout(syncT);
    syncT = setTimeout(function () {
      if (!kReady()) return;
      if (!ready) {
        ready = true;
        root.setAttribute('data-kaching', 'ready');
        driveKaching();
      }
      // Kaching's controls are driven by the approved picker; keep them out of the tab order
      $$('input, button, a, [tabindex]', kHost).forEach(function (el) {
        if (el.getAttribute('tabindex') !== '-1') el.setAttribute('tabindex', '-1');
      });
      applyOfferMode();
      paint();
    }, 60);
  }
  if (kHost && 'MutationObserver' in window) {
    new MutationObserver(onKachingChange).observe(kHost, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-checked', 'src'] });
  }
  onKachingChange();
  window.addEventListener('load', onKachingChange);
  setTimeout(function () {
    if (ready) return;
    root.setAttribute('data-kaching', 'failed');
    showError('We couldn’t load the offer. Please refresh the page and try again.');
  }, 15000);

  /* ---------------------------------------------------------------
     4. The one add-to-cart path (theme <product-form>, rewritten by Kaching)
     --------------------------------------------------------------- */
  var pending = false;
  function theForm() { var h = $('.ewld-form-host'); return h ? h.querySelector('form[action*="/cart/add"]') : null; }
  function showError(msg) {
    var w = $('.ewld-form-host .product-form__error-message-wrapper');
    if (!w) return;
    var t = w.querySelector('.product-form__error-message');
    if (t) t.textContent = msg;
    w.hidden = false;
  }
  function release() {
    pending = false;
    if (atc && ready) { atc.disabled = false; atc.removeAttribute('aria-busy'); }
  }
  function watchForDrawer() {
    var drawer = document.querySelector('cart-drawer');
    if (!drawer) { setTimeout(release, 4000); return; }
    var done = false;
    var obs = new MutationObserver(function () {
      if (drawer.classList.contains('active') || drawer.classList.contains('is-open')) finish();
    });
    function finish() { if (done) return; done = true; obs.disconnect(); release(); }
    obs.observe(drawer, { attributes: true, attributeFilter: ['class'] });
    setTimeout(finish, 8000);
  }
  function selectionDetail() {
    var t = tiers.filter(function (el) { return +el.getAttribute('data-ewld-tier') === state.tier; })[0];
    var gifts = [];
    if (t) $$('[data-ewld-gift-list] > span', t).forEach(function (r) {
      var col = r.children[1];
      var l = col && col.children[0] ? col.children[0] : r;
      gifts.push(txt(l).replace(/^🎁\s*/, ''));
    });
    return {
      bundle: 'bundle-' + (state.tier + 1),
      dealId: DEAL_IDS[state.tier],
      title: t ? txt(t.querySelector('[data-ewld-title]')) : '',
      offer: t ? txt(t.querySelector('[data-ewld-badge]')) : '',
      price: kPrice(state.tier),
      currency: (atc && atc.getAttribute('data-currency')) || 'USD',
      compareAt: kCompare(state.tier),
      purchaseType: state.routine ? 'subscription' : 'one-time',
      sellingPlanId: state.routine ? (sellingPlanField() || null) : null,
      gifts: gifts,
      offerVariant: root.getAttribute('data-offer'),
      page: 'eyewipes-lander'
    };
  }
  var retries = 0;
  if (atc) {
    atc.addEventListener('click', function (e) {
      if (pending || !ready) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      // Kaching must hold exactly the bundle + purchase type the shopper sees
      if (!inSync()) {
        e.preventDefault(); e.stopImmediatePropagation();
        driveKaching();
        if (retries++ < 4) setTimeout(function () { atc.click(); }, 450);
        else { retries = 0; showError('Please choose your kit again and retry.'); }
        return;
      }
      retries = 0;
      var detail = selectionDetail();
      window.__ewCartSelection = detail;
      var ev;
      try { ev = new CustomEvent('vetpets:add-to-cart', { detail: detail, cancelable: true, bubbles: true }); } catch (x) { ev = null; }
      if (ev && !atc.dispatchEvent(ev)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      try { (window.dataLayer = window.dataLayer || []).push({ event: 'vetpets_add_to_cart', vetpets: detail }); } catch (x) {}
      var w = $('.ewld-form-host .product-form__error-message-wrapper');
      if (w) w.hidden = true;
      pending = true;
      // disable on a later task so this click still produces the submit event
      setTimeout(function () { atc.disabled = true; atc.setAttribute('aria-busy', 'true'); }, 0);
      watchForDrawer();
    });
  }

  /* ---------------------------------------------------------------
     5. Sticky CTA bar: after the hero CTA has scrolled away, until the offer is in view
     --------------------------------------------------------------- */
  var sticky = $('[data-ewld-sticky]');
  var heroCta = $('[data-ewld-hero-cta]');
  var offerSec = $('[data-ewld-offer-section]');
  function onScroll() {
    if (!sticky) return;
    var heroGone = heroCta ? heroCta.getBoundingClientRect().bottom < 0 : window.scrollY > 600;
    var offerIn = offerSec ? offerSec.getBoundingClientRect().top < window.innerHeight * 0.85 : false;
    sticky.classList.toggle('is-on', heroGone && !offerIn);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  /* ---------------------------------------------------------------
     6. Carousels (shared stepper from the design)
     --------------------------------------------------------------- */
  function step(el, sel, dir) {
    if (!el) return;
    var card = el.querySelector(sel);
    var gap = parseFloat(getComputedStyle(el).columnGap) || 12;
    var w = card ? card.getBoundingClientRect().width + gap : el.clientWidth * 0.8;
    var behavior = reduce() ? 'auto' : 'smooth';
    var max = el.scrollWidth - el.clientWidth;
    if (dir > 0 && el.scrollLeft >= max - 6) el.scrollTo({ left: 0, behavior: behavior });
    else if (dir < 0 && el.scrollLeft <= 6) el.scrollTo({ left: max, behavior: behavior });
    else el.scrollBy({ left: dir * w, behavior: behavior });
  }
  var MANUAL = ['pointerdown', 'touchstart', 'wheel', 'keydown'];

  /* Trustpilot */
  var tp = $('[data-ewld-tp]');
  var tpWrap = $('[data-ewld-tp-wrap]');
  var tpHover = false, tpFocus = false, tpManualUntil = 0;
  if (tp) {
    MANUAL.forEach(function (ev) { tp.addEventListener(ev, function () { tpManualUntil = Date.now() + 6000; }, { passive: true }); });
    var tpPrev = $('[data-ewld-tp-prev]'), tpNext = $('[data-ewld-tp-next]');
    if (tpPrev) tpPrev.addEventListener('click', function () { tpManualUntil = Date.now() + 6000; step(tp, '.tp-card', -1); });
    if (tpNext) tpNext.addEventListener('click', function () { tpManualUntil = Date.now() + 6000; step(tp, '.tp-card', 1); });
    if (tpWrap) {
      tpWrap.addEventListener('mouseenter', function () { tpHover = true; });
      tpWrap.addEventListener('mouseleave', function () { tpHover = false; });
      tpWrap.addEventListener('focusin', function () { tpFocus = true; });
      tpWrap.addEventListener('focusout', function () { tpFocus = false; });
    }
    var tpSec = Math.max(3, Number(root.getAttribute('data-tp-sec')) || 4);
    if (root.getAttribute('data-tp-auto') !== 'false') {
      setInterval(function () {
        if (reduce() || document.hidden || tpHover || tpFocus || Date.now() < tpManualUntil) return;
        var r = tp.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) return;
        step(tp, '.tp-card', 1);
      }, tpSec * 1000);
    }
  }

  /* UGC videos: visible clips play muted; one clip at a time with sound */
  var ugc = $('[data-ewld-ugc]');
  var vids = $$('[data-ewld-ugc-video]');
  var soundBtns = $$('[data-ewld-sound]');
  var autoBtn = $('[data-ewld-ugc-auto]');
  var ugcIn = false, ugcAuto = true, ugcManualUntil = 0, sound = null, soundErr = null, ugcSyncT;

  vids.forEach(function (v) {
    v.muted = true; v.defaultMuted = true; v.playsInline = true;
    v.addEventListener('volumechange', function () {
      var idx = -1;
      vids.forEach(function (o, n) { if (idx < 0 && !o.muted) idx = n; });
      var s = idx < 0 ? null : idx;
      if (s !== sound) { sound = s; paintSound(); ugcSync(); }
    });
  });
  function paintSound() {
    soundBtns.forEach(function (b, i) {
      var on = sound === i;
      var name = b.getAttribute('data-name');
      b.setAttribute('data-ewld-state', on ? 'on' : 'off');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-label', on ? 'Mute ' + name + '’s video' : 'Play ' + name + '’s video with sound');
      var t = b.querySelector('[data-ewld-sound-text]');
      if (t) t.textContent = on ? 'Mute' : (soundErr === i ? 'Sound blocked — tap again' : 'Tap for sound');
    });
  }
  function ugcSync() {
    clearTimeout(ugcSyncT);
    ugcSyncT = setTimeout(function () {
      if (!ugc) return;
      var tr = ugc.getBoundingClientRect();
      var still = reduce() && sound === null;
      vids.forEach(function (v, i) {
        var r = v.getBoundingClientRect();
        var visible = ugcIn && r.right > tr.left + 8 && r.left < tr.right - 8;
        var want = sound === i || (visible && !still && sound === null);
        if (want) {
          if (v.preload !== 'auto') v.preload = 'auto';
          if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        } else if (!v.paused) v.pause();
      });
    }, 120);
  }
  function toggleSound(i) {
    var v = vids[i];
    if (!v) return;
    ugcManualUntil = Date.now() + 6000;
    if (!v.muted && !v.paused) {
      v.muted = true; v.defaultMuted = true;
      sound = null; soundErr = null; paintSound(); ugcSync();
      return;
    }
    vids.forEach(function (o, n) { if (n !== i) { o.muted = true; o.defaultMuted = true; } });
    v.defaultMuted = false; v.removeAttribute('muted'); v.muted = false; v.volume = 1;
    if (v.preload !== 'auto') v.preload = 'auto';
    if (sound !== i) { try { v.currentTime = 0; } catch (x) {} }
    sound = i; soundErr = null; paintSound();
    var p = v.play();
    if (p && p.then) p.then(ugcSync, function (err) {
      if ((err && err.name === 'AbortError') || sound !== i) return;
      if (window.console) console.warn('[EyeWipes UGC] Sound playback failed for clip ' + (i + 1) + ':', err && err.name, err && err.message);
      v.muted = true; v.defaultMuted = true;
      sound = null; soundErr = i; paintSound(); ugcSync();
    });
  }
  soundBtns.forEach(function (b) {
    b.addEventListener('click', function () { toggleSound(+b.getAttribute('data-ewld-sound')); });
  });
  if (ugc) {
    MANUAL.forEach(function (ev) { ugc.addEventListener(ev, function () { ugcManualUntil = Date.now() + 6000; }, { passive: true }); });
    ugc.addEventListener('scroll', ugcSync, { passive: true });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (en) { ugcIn = en[0].isIntersecting; ugcSync(); }, { threshold: 0.2 }).observe(ugc);
    }
    var up = $('[data-ewld-ugc-prev]'), un = $('[data-ewld-ugc-next]');
    if (up) up.addEventListener('click', function () { ugcManualUntil = Date.now() + 6000; step(ugc, '.ugc-track > *', -1); });
    if (un) un.addEventListener('click', function () { ugcManualUntil = Date.now() + 6000; step(ugc, '.ugc-track > *', 1); });
    if (autoBtn) autoBtn.addEventListener('click', function () {
      ugcAuto = !ugcAuto;
      autoBtn.setAttribute('data-ewld-state', ugcAuto ? 'on' : 'off');
      autoBtn.setAttribute('aria-label', ugcAuto ? 'Pause video carousel' : 'Play video carousel');
    });
    setInterval(function () {
      if (!ugcAuto || reduce() || document.hidden || !ugcIn) return;
      if (sound !== null || Date.now() < ugcManualUntil) return;
      step(ugc, '.ugc-track > *', 1);
    }, 4000);
  }

  /* Demo video: autoplay muted while on screen, pause/play button */
  var demo = $('[data-ewld-demo]');
  var demoBtn = $('[data-ewld-demo-toggle]');
  var demoPaused = false;
  function paintDemo() {
    if (!demoBtn) return;
    demoBtn.setAttribute('data-ewld-state', demoPaused ? 'off' : 'on');
    demoBtn.setAttribute('aria-label', demoPaused ? 'Play demonstration video' : 'Pause demonstration video');
  }
  if (demo) {
    demo.muted = true; demo.defaultMuted = true; demo.loop = true; demo.playsInline = true;
    var playDemo = function () { var p = demo.play(); if (p && p.catch) p.catch(function () {}); };
    if (reduce()) { demo.pause(); demoPaused = true; }
    else {
      playDemo();
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (en) {
          if (demoPaused) return;
          if (en[0].isIntersecting) playDemo(); else demo.pause();
        }, { threshold: 0.25 }).observe(demo);
      }
    }
    paintDemo();
    if (demoBtn) demoBtn.addEventListener('click', function () {
      if (demo.paused) { playDemo(); demoPaused = false; } else { demo.pause(); demoPaused = true; }
      paintDemo();
    });
  }

  paint();
})();
