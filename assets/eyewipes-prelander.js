/*
  EyeWipes pre-lander — scoped behaviour.

  Loaded only by layout/eyewipes-prelander.liquid. Everything is looked up
  inside #eyewipes-prelander and nothing is written to the global scope, so
  this file cannot affect any other page of the storefront.

  Progressive enhancement only. With JavaScript disabled the page still
  renders and every link still works; only the live countdown, the mobile
  comparison tabs, the review-rail arrows and attribution forwarding are lost.
*/
(function () {
  'use strict';

  var root = document.getElementById('eyewipes-prelander');
  if (!root) return;

  /* ---------------------------------------------------------------
     1. Countdown to local midnight
     --------------------------------------------------------------- */
  (function countdown() {
    var h = root.querySelector('[data-ewpl-cd="h"]');
    var m = root.querySelector('[data-ewpl-cd="m"]');
    var s = root.querySelector('[data-ewpl-cd="s"]');
    if (!h || !m || !s) return;

    function pad(n) { return String(n).padStart(2, '0'); }

    function tick() {
      var end = new Date();
      end.setHours(24, 0, 0, 0);
      var left = Math.max(0, Math.floor((end.getTime() - Date.now()) / 1000));
      h.textContent = pad(Math.floor(left / 3600));
      m.textContent = pad(Math.floor((left % 3600) / 60));
      s.textContent = pad(left % 60);
    }

    tick();
    setInterval(tick, 1000);
  }());

  /* ---------------------------------------------------------------
     2. Mobile comparison tabs
     --------------------------------------------------------------- */
  (function comparisonTabs() {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('.ewpl-cmp__tab'));
    var panels = Array.prototype.slice.call(root.querySelectorAll('.ewpl-cmp__panel'));
    if (!tabs.length || !panels.length) return;

    function select(index) {
      tabs.forEach(function (tab, i) {
        tab.setAttribute('aria-selected', i === index ? 'true' : 'false');
        tab.setAttribute('tabindex', i === index ? '0' : '-1');
      });
      panels.forEach(function (panel, i) {
        if (i === index) {
          panel.removeAttribute('hidden');
        } else {
          panel.setAttribute('hidden', '');
        }
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
    var rail = root.querySelector('.ewpl-reviews__rail');
    var prev = root.querySelector('[data-ewpl-rail="prev"]');
    var next = root.querySelector('[data-ewpl-rail="next"]');
    if (!rail || !prev || !next) return;

    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function scrollBy(direction) {
      rail.scrollBy({
        left: direction * rail.clientWidth * 0.9,
        behavior: reduced ? 'auto' : 'smooth'
      });
    }

    prev.addEventListener('click', function () { scrollBy(-1); });
    next.addEventListener('click', function () { scrollBy(1); });
  }());

  /* ---------------------------------------------------------------
     3b. Keep the page bottom clear of the sticky bar

     The design reserves a fixed 104px. Measuring the real bar keeps the last
     section clear of it whatever the label wraps to.
     --------------------------------------------------------------- */
  (function stickyClearance() {
    var bar = root.querySelector('.ewpl-sticky');
    if (!bar) {
      root.style.setProperty('--ewpl-sticky-h', '0px');
      return;
    }

    function measure() {
      var height = Math.ceil(bar.getBoundingClientRect().height);
      if (height > 0) root.style.setProperty('--ewpl-sticky-h', height + 'px');
    }

    measure();
    window.addEventListener('resize', measure);
    if (window.ResizeObserver) new ResizeObserver(measure).observe(bar);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  }());

  /* ---------------------------------------------------------------
     4. Forward advertising attribution to the PDP
     --------------------------------------------------------------- */
  (function forwardAttribution() {
    var links = Array.prototype.slice.call(root.querySelectorAll('a[data-ewpl-pdp]'));
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
      if (key.indexOf('utm_') === 0 || CLICK_IDS.indexOf(key) !== -1) {
        carry.push([key, value]);
      }
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
