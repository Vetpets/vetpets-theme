/*
  EyeWipes pre-lander — scoped behaviour.

  Loaded only by layout/eyewipes-prelander.liquid. Everything is looked up
  inside #eyewipes-prelander and nothing is written to the global scope, so
  this file cannot affect any other page of the storefront.

  Progressive enhancement only. With JavaScript disabled the page still
  renders and every link still works; only the announcement-bar rotation, the
  mobile comparison tabs, the review-rail arrows and attribution forwarding
  are lost.
*/
(function () {
  'use strict';

  var root = document.getElementById('eyewipes-prelander');
  if (!root) return;

  /* ---------------------------------------------------------------
     1. rotating announcement bar — no countdown, no scarcity copy.
     One message shown at a time, centered, cross-faded + slid every 4s,
     looping. Icon + text swap together, one per message in the fixed
     price-tag / truck / gift order — the same bar approved on the
     EyeWipes and FreshWipes offer pages. prefers-reduced-motion drops
     the transition but keeps the rotation itself, per WCAG guidance on
     non-essential motion.
     --------------------------------------------------------------- */
  (function announce() {
    var el = root.querySelector('[data-ewpl-announce-msg]');
    var iconEl = root.querySelector('[data-ewpl-announce-icon]');
    var textEl = root.querySelector('[data-ewpl-announce-text]');
    if (!el || !iconEl || !textEl) return;
    var MESSAGES = ['Buy 2, Get 2 Free', 'Free Shipping with RoutineCare', 'Free Gifts Included'];
    var ICONS = [
      /* price tag — "Buy 2, Get 2 Free" */
      '<path d="M11.5 3H5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 .586 1.414l8.5 8.5a2 2 0 0 0 2.828 0l6.5-6.5a2 2 0 0 0 0-2.828l-8.5-8.5A2 2 0 0 0 11.5 3Z"></path><circle cx="7.25" cy="7.25" r="1.1" fill="currentColor" stroke="none"></circle>',
      /* delivery truck — "Free Shipping with RoutineCare" */
      '<rect x="1.5" y="6" width="12" height="8" rx="1"></rect><path d="M13.5 9h4l3 3.2V14h-7Z"></path><circle cx="6" cy="16.5" r="1.8" fill="currentColor" stroke="none"></circle><circle cx="17" cy="16.5" r="1.8" fill="currentColor" stroke="none"></circle>',
      /* gift box — "Free Gifts Included" */
      '<rect x="3" y="9" width="18" height="11" rx="1.2"></rect><path d="M3 13h18"></path><path d="M12 9v11"></path><path d="M8.2 9c-1.9 0-3-1-3-2.4C5.2 5.2 6.3 4 7.8 4 9.6 4 11 6 12 9"></path><path d="M15.8 9c1.9 0 3-1 3-2.4C18.8 5.2 17.7 4 16.2 4 14.4 4 13 6 12 9"></path>'
    ];
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var i = 0;
    var paint = function () {
      textEl.textContent = MESSAGES[i];
      iconEl.innerHTML = ICONS[i % ICONS.length];
    };
    var swap = function () {
      i = (i + 1) % MESSAGES.length;
      if (reduceMotion) {
        paint();
        return;
      }
      el.classList.add('is-out');
      window.setTimeout(function () {
        paint();
        el.classList.remove('is-out');
        el.classList.add('is-in');
        void el.offsetWidth; /* force reflow so the entrance transition runs */
        el.classList.remove('is-in');
      }, 240);
    };
    setInterval(swap, 4000);
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
