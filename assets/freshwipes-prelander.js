/*
  FreshWipes pre-lander — scoped behaviour.

  Loaded only by layout/freshwipes-prelander.liquid. Everything is looked up
  inside #freshwipes-prelander and nothing is written to the global scope, so
  this file cannot affect any other page of the storefront.

  Progressive enhancement only. With JavaScript disabled the page still renders
  and every link still works; only the ticking countdown, the mobile comparison
  tabs, the review-rail arrows, exact sticky clearance and attribution
  forwarding are lost.
*/
(function () {
  'use strict';

  var root = document.getElementById('freshwipes-prelander');
  if (!root) return;

  /* ---------------------------------------------------------------
     1. Offer countdown

     Mirrors the design: starts at 04:05:15, ticks down once a second and
     rolls back to the start when it reaches zero.
     --------------------------------------------------------------- */
  (function countdown() {
    var h = root.querySelector('[data-fwpl-cd="h"]');
    var m = root.querySelector('[data-fwpl-cd="m"]');
    var s = root.querySelector('[data-fwpl-cd="s"]');
    if (!h || !m || !s) return;

    var START = { hrs: 4, min: 5, sec: 15 };
    var t = { hrs: START.hrs, min: START.min, sec: START.sec };

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function paint() {
      h.textContent = pad(t.hrs);
      m.textContent = pad(t.min);
      s.textContent = pad(t.sec);
    }

    setInterval(function () {
      t.sec--;
      if (t.sec < 0) { t.sec = 59; t.min--; }
      if (t.min < 0) { t.min = 59; t.hrs--; }
      if (t.hrs < 0) { t.hrs = START.hrs; t.min = START.min; t.sec = START.sec; }
      paint();
    }, 1000);

    paint();
  }());

  /* ---------------------------------------------------------------
     2. Mobile comparison tabs
     --------------------------------------------------------------- */
  (function comparisonTabs() {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('.fwpl-cmp__tab'));
    var panels = Array.prototype.slice.call(root.querySelectorAll('.fwpl-cmp__panel'));
    if (!tabs.length || !panels.length) return;

    function select(index) {
      tabs.forEach(function (tab, i) {
        tab.setAttribute('aria-selected', i === index ? 'true' : 'false');
        tab.setAttribute('tabindex', i === index ? '0' : '-1');
      });
      panels.forEach(function (panel, i) {
        if (i === index) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
      });
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(i); });
      tab.addEventListener('keydown', function (event) {
        var next = null;
        if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
        if (next === null) return;
        event.preventDefault();
        select(next);
        tabs[next].focus();
      });
    });
  }());

  /* ---------------------------------------------------------------
     3. Review rail arrows
     --------------------------------------------------------------- */
  (function reviewRail() {
    var rail = root.querySelector('.fwpl-reviews__rail');
    var prev = root.querySelector('[data-fwpl-rail="prev"]');
    var next = root.querySelector('[data-fwpl-rail="next"]');
    if (!rail || !prev || !next) return;

    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function nudge(direction) {
      rail.scrollBy({ left: direction * 338, behavior: reduced ? 'auto' : 'smooth' });
    }

    prev.addEventListener('click', function () { nudge(-1); });
    next.addEventListener('click', function () { nudge(1); });
  }());

  /* ---------------------------------------------------------------
     4. Sticky clearance

     The spacer reserves --fw-sticky-h + 16px. Measuring the real bar keeps
     the offer card clear of it however the label wraps.
     --------------------------------------------------------------- */
  (function stickyClearance() {
    var bar = root.querySelector('.fwpl-sticky');
    if (!bar) {
      root.style.setProperty('--fw-sticky-h', '0px');
      return;
    }

    function measure() {
      var height = Math.ceil(bar.getBoundingClientRect().height);
      if (height > 0) root.style.setProperty('--fw-sticky-h', height + 'px');
    }

    measure();
    window.addEventListener('resize', measure);
    if (window.ResizeObserver) new ResizeObserver(measure).observe(bar);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  }());

  /* ---------------------------------------------------------------
     5. Forward advertising attribution to the PDP
     --------------------------------------------------------------- */
  (function forwardAttribution() {
    var links = Array.prototype.slice.call(root.querySelectorAll('a[data-fwpl-pdp]'));
    if (!links.length) return;

    var CLICK_IDS = [
      'fbclid', 'gclid', 'gbraid', 'wbraid', 'gad_source', 'gclsrc',
      'msclkid', 'ttclid', 'twclid', 'li_fat_id', 'epik', 'irclickid',
      'rdt_cid', 'sccid', 'yclid', 'ScCid',
      'preview_theme_id'
    ];

    var incoming;
    try {
      incoming = new URLSearchParams(window.location.search);
    } catch (error) {
      return;
    }

    var carry = [];
    incoming.forEach(function (value, key) {
      if (!value) return;
      if (key.indexOf('utm_') === 0 || CLICK_IDS.indexOf(key) !== -1) carry.push([key, value]);
    });
    if (!carry.length) return;

    links.forEach(function (link) {
      var url;
      try {
        url = new URL(link.getAttribute('href'), window.location.href);
      } catch (error) {
        return;
      }
      carry.forEach(function (pair) {
        // never overwrite a parameter the design already put on the link
        if (!url.searchParams.has(pair[0])) url.searchParams.set(pair[0], pair[1]);
      });
      link.setAttribute('href', url.toString());
    });
  }());
}());
