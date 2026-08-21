/*
 * VetPets Subscription Portal — UI controller
 * ------------------------------------------------------------------
 * Owns navigation, rendering, sheets, pending/toast/error states and
 * focus management. It never fetches and never formats currency on its
 * own — everything comes from the adapter, so replacing the mock with
 * the real backend requires no change in this file.
 */
(function (window, document) {
  'use strict';

  var NS = window.VetPetsPortal;
  if (!NS) return;

  var SCREENS_WITH_CHROME = {
    login: false, sent: false, expired: false, loading: false, error: false
  };

  function Portal(root) {
    this.root = root;
    this.cfg = this.readConfig(root);
    this.adapter = NS.createMockAdapter({
      today: this.cfg.today,
      currencyCode: this.cfg.currency,
      latency: this.cfg.latency,
      pointsPerRenewal: this.cfg.pointsPerRenewal,
      nextRewardAt: this.cfg.nextRewardAt,
      nextRewardName: this.cfg.nextRewardName,
      images: this.cfg.images
    });

    this.state = {
      screen: 'loading',
      sheet: null,
      pending: null,
      lastFocus: null,
      draft: {
        delay: 7,
        freq: null,
        pauseMonths: 2,
        reason: 'price',
        restart: 0,
        swapPick: 0,
        addonPick: null,
        quantities: {}
      },
      data: null,       // subscription projection
      loyalty: null,
      customer: null,
      inactive: [],
      deliveries: null,
      rewards: [],
      swapOptions: [],
      addonOptions: [],
      error: null,
      success: null,
      history: []
    };

    this.bind();
    this.boot();
  }

  /* =================================================================
   * Config
   * ================================================================= */

  Portal.prototype.readConfig = function (root) {
    var d = root.dataset;
    return {
      locale: d.sppLocale || 'en',
      today: d.sppToday || '2026-08-21',
      currency: d.sppCurrency || 'USD',
      latency: parseInt(d.sppLatency, 10) || 0,
      pointsPerRenewal: parseInt(d.sppPointsPerRenewal, 10) || 100,
      nextRewardAt: parseInt(d.sppNextRewardAt, 10) || 800,
      nextRewardName: d.sppNextRewardName || 'a free plush toy',
      images: {
        freshwipes: d.sppImgFreshwipes || '',
        eyewipes: d.sppImgEyewipes || '',
        glovewipes: d.sppImgGlovewipes || '',
        reward: ''
      },
      devDefault: d.sppDevDefault === 'true'
    };
  };

  /* =================================================================
   * Formatting helpers (locale aware — never hardcodes a symbol)
   * ================================================================= */

  Portal.prototype.fmtMoney = function (value) {
    return NS.formatMoney(value, this.cfg.locale);
  };

  Portal.prototype.fmtDate = function (iso, style) {
    if (!iso) return '';
    var date = NS.dates.parseISO(iso);
    var opts;
    if (style === 'long') opts = { weekday: 'long', month: 'long', day: 'numeric' };
    else if (style === 'medium') opts = { weekday: 'short', month: 'short', day: 'numeric' };
    else if (style === 'short') opts = { month: 'short', day: 'numeric' };
    else if (style === 'full') opts = { day: 'numeric', month: 'long', year: 'numeric' };
    else if (style === 'monthOnly') opts = { month: 'long', day: 'numeric' };
    else opts = { month: 'short', day: 'numeric' };
    try {
      return new Intl.DateTimeFormat(this.cfg.locale, opts).format(date);
    } catch (e) {
      return iso;
    }
  };

  /* =================================================================
   * Boot
   * ================================================================= */

  Portal.prototype.boot = function () {
    var self = this;
    var params = new URLSearchParams(window.location.search);

    if (params.get('spp_dev') === '1' || this.cfg.devDefault) {
      this.root.classList.add('is-dev');
      var dev = this.root.querySelector('[data-spp-dev]');
      if (dev) dev.hidden = false;
    }

    // A magic-link token in the URL decides where we land.
    var token = params.get('spp_token');
    var start = params.get('spp_screen');

    this.show('loading');

    if (token) {
      this.adapter.verifyMagicLink(token)
        .then(function () { return self.load(); })
        .then(function () { self.show(start || 'dashboard'); })
        .catch(function (err) {
          if (err && err.code === 'expired_link') self.show('expired');
          else self.fail(err);
        });
      return;
    }

    this.load()
      .then(function () { self.show(start || 'dashboard'); })
      .catch(function (err) { self.fail(err); });
  };

  /** Fetch everything the portal renders from. */
  Portal.prototype.load = function () {
    var self = this;
    return Promise.all([
      this.adapter.getCustomer(),
      this.adapter.getSubscription(),
      this.adapter.getLoyalty(),
      this.adapter.listSubscriptions(),
      this.adapter.listDeliveries(),
      this.adapter.listRewards(),
      this.adapter.listSwapOptions(),
      this.adapter.listAddonOptions()
    ]).then(function (r) {
      self.state.customer = r[0];
      self.state.data = r[1];
      self.state.loyalty = r[2];
      self.state.inactive = r[3].inactive;
      self.state.deliveries = r[4];
      self.state.rewards = r[5];
      self.state.swapOptions = r[6];
      self.state.addonOptions = r[7];

      if (self.state.draft.freq === null) self.state.draft.freq = r[1].intervalDays;
      self.syncQuantityDraft();
      self.render();
    });
  };

  Portal.prototype.syncQuantityDraft = function () {
    var q = {};
    (this.state.data ? this.state.data.lines : []).forEach(function (l) { q[l.id] = l.quantity; });
    this.state.draft.quantities = q;
  };

  Portal.prototype.fail = function (err) {
    this.state.error = {
      code: (err && err.code) || 'server',
      reference: (err && err.reference) || this.buildReference(err)
    };
    this.render();
    this.show('error');
  };

  Portal.prototype.buildReference = function (err) {
    var code = (err && err.code) || 'server';
    var stamp = this.fmtDate(this.cfg.today, 'full');
    var prefix = code === 'network' ? 'SUB-000' : 'SUB-503';
    return prefix + ' · ' + stamp;
  };

  /* =================================================================
   * Navigation
   * ================================================================= */

  Portal.prototype.show = function (screen) {
    if (this.state.screen !== screen) this.state.history.push(this.state.screen);
    this.state.screen = screen;
    this.closeSheet(true);

    var sections = this.root.querySelectorAll('[data-spp-screen]');
    for (var i = 0; i < sections.length; i++) {
      sections[i].hidden = sections[i].getAttribute('data-spp-screen') !== screen;
    }

    // Chrome (header nav + tab bar) is hidden on pre-auth and system screens.
    var showChrome = SCREENS_WITH_CHROME[screen] !== false;
    var chrome = this.root.querySelectorAll('[data-spp-chrome]');
    for (var j = 0; j < chrome.length; j++) chrome[j].hidden = !showChrome;

    this.markCurrentNav(screen);
    this.render();

    var main = this.root.querySelector('#spp-main');
    if (main) {
      main.scrollTop = 0;
      // Move focus to the screen so keyboard and screen-reader users land
      // on the new content rather than staying on the old control.
      var heading = this.root.querySelector('[data-spp-screen="' + screen + '"]');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        try { heading.focus({ preventScroll: true }); } catch (e) { heading.focus(); }
      }
    }
  };

  Portal.prototype.markCurrentNav = function (screen) {
    var navs = this.root.querySelectorAll('[data-spp-nav]');
    for (var i = 0; i < navs.length; i++) {
      var match = navs[i].getAttribute('data-spp-nav') === screen;
      if (match) navs[i].setAttribute('aria-current', 'page');
      else navs[i].removeAttribute('aria-current');
    }
    var devBtns = this.root.querySelectorAll('[data-spp-dev] [data-spp-go]');
    for (var k = 0; k < devBtns.length; k++) {
      var m = devBtns[k].getAttribute('data-spp-go') === screen;
      if (m) devBtns[k].setAttribute('aria-current', 'true');
      else devBtns[k].removeAttribute('aria-current');
    }
  };

  /* =================================================================
   * Sheets
   * ================================================================= */

  Portal.prototype.openSheet = function (name) {
    var overlay = this.root.querySelector('[data-spp-overlay]');
    var host = this.root.querySelector('[data-spp-sheet-host]');
    if (!overlay || !host) return;

    this.state.lastFocus = document.activeElement;
    this.state.sheet = name;

    if (name === 'qty') this.syncQuantityDraft();
    if (name === 'freq' && this.state.data) this.state.draft.freq = this.state.data.intervalDays;

    var panels = host.querySelectorAll('[data-spp-sheet-panel]');
    for (var i = 0; i < panels.length; i++) {
      panels[i].hidden = panels[i].getAttribute('data-spp-sheet-panel') !== name;
    }
    host.setAttribute('aria-labelledby', 'spp-sheet-h-' + name);
    overlay.hidden = false;

    this.render();

    var focusable = this.focusablesIn(host);
    if (focusable.length) focusable[0].focus();
    else host.focus();
  };

  Portal.prototype.closeSheet = function (silent) {
    var overlay = this.root.querySelector('[data-spp-overlay]');
    if (!overlay || overlay.hidden) { this.state.sheet = null; return; }
    overlay.hidden = true;
    this.state.sheet = null;
    var host = this.root.querySelector('[data-spp-sheet-host]');
    if (host) host.classList.remove('is-pending');
    var note = this.root.querySelector('[data-spp-pending-note]');
    if (note) note.hidden = true;
    if (!silent && this.state.lastFocus && this.state.lastFocus.focus) {
      try { this.state.lastFocus.focus(); } catch (e) {}
    }
    this.state.lastFocus = null;
  };

  Portal.prototype.focusablesIn = function (el) {
    var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(el.querySelectorAll(sel), function (n) {
      return n.offsetParent !== null || n === document.activeElement;
    });
  };

  /* =================================================================
   * Toast
   * ================================================================= */

  Portal.prototype.toast = function (message) {
    var el = this.root.querySelector('[data-spp-toast]');
    if (!el || !message) return;
    var slot = el.querySelector('[data-spp-field="toast.message"]');
    if (slot) slot.textContent = message;
    el.hidden = false;
    var self = this;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  };

  /* =================================================================
   * Mutation runner — pending state, error handling, refetch
   * ================================================================= */

  /**
   * run(key, work, opts)
   *   key   identifies the button/sheet showing the pending state
   *   work  () => Promise
   *   opts  { toast, then, closeSheet, success }
   */
  Portal.prototype.run = function (key, work, opts) {
    var self = this;
    opts = opts || {};
    if (this.state.pending) return Promise.resolve();

    this.state.pending = key;
    this.applyPending(true);
    this.render();

    return work()
      .then(function (result) {
        self.state.pending = null;
        self.applyPending(false);

        if (result && result.id) self.state.data = result;
        if (result && typeof result.points === 'number') self.state.loyalty = result;

        return self.adapter.getLoyalty().then(function (loy) {
          self.state.loyalty = loy;
          return self.adapter.listSubscriptions();
        }).then(function (subs) {
          self.state.inactive = subs.inactive;
          return self.adapter.listDeliveries();
        }).then(function (dels) {
          self.state.deliveries = dels;
          self.syncQuantityDraft();

          if (opts.closeSheet !== false) self.closeSheet();
          if (opts.success) {
            self.state.success = opts.success(self.state);
            self.show('success');
          } else if (opts.then) {
            opts.then(self.state);
          } else {
            self.render();
          }
          if (opts.toast) self.toast(typeof opts.toast === 'function' ? opts.toast(self.state) : opts.toast);
        });
      })
      .catch(function (err) {
        self.state.pending = null;
        self.applyPending(false);
        self.closeSheet(true);
        self.fail(err);
      });
  };

  Portal.prototype.applyPending = function (on) {
    var host = this.root.querySelector('[data-spp-sheet-host]');
    var note = this.root.querySelector('[data-spp-pending-note]');
    if (host && this.state.sheet) host.classList.toggle('is-pending', !!on);
    if (note && this.state.sheet) note.hidden = !on;

    var buttons = this.root.querySelectorAll('[data-spp-act]');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var isThis = on && b.getAttribute('data-spp-act') === this.state.pending;
      b.classList.toggle('is-pending', !!isThis);
      if (on) b.setAttribute('aria-disabled', 'true');
      else b.removeAttribute('aria-disabled');
      // Show a spinner inside the button that is actually working.
      var spinner = b.querySelector('.spp__spinner');
      if (isThis && !spinner) {
        var s = document.createElement('span');
        s.className = 'spp__spinner';
        b.insertBefore(s, b.firstChild);
      } else if (!isThis && spinner && spinner.parentNode === b) {
        b.removeChild(spinner);
      }
    }
  };

  /* =================================================================
   * View model
   * ================================================================= */

  Portal.prototype.viewModel = function () {
    var s = this.state;
    var sub = s.data;
    var loy = s.loyalty;
    var cus = s.customer;
    var d = this.state.draft;
    var self = this;
    var today = this.cfg.today;

    var vm = {};

    if (cus) {
      vm['customer.initials'] = cus.initials;
      vm['customer.firstName'] = cus.firstName;
      vm['customer.fullName'] = cus.firstName + ' ' + cus.lastName;
      vm['customer.email'] = cus.email;
    }

    if (sub) {
      var statusLabel = sub.status === 'active' ? 'Active' : (sub.status === 'paused' ? 'Paused' : 'Cancelled');
      vm['subscription.reference'] = sub.reference;
      vm['subscription.statusLabel'] = statusLabel;
      vm['subscription.intervalDays'] = String(sub.intervalDays);
      vm['subscription.nextOrderMedium'] = this.fmtDate(sub.nextOrderDate, 'medium');
      vm['subscription.nextOrderShort'] = this.fmtDate(sub.nextOrderDate, 'short');
      vm['subscription.startedLong'] = this.fmtDate(sub.startedOn, 'full');
      vm['subscription.deliveriesSoFar'] = String(sub.deliveriesSoFar);
      vm['subscription.discountPercent'] = String(Math.round(sub.discountRate * 100));
      vm['subscription.daysAway'] = sub.daysUntilNextOrder + ' days away';
      vm['subscription.progressLabel'] = 'Next delivery in ' + sub.daysUntilNextOrder + ' days';
      vm['subscription.shipProgress'] = Math.max(6, 100 - Math.min(100, sub.daysUntilNextOrder * 1.6));
      vm['subscription.pausedUntilLong'] = sub.pausedUntil ? this.fmtDate(sub.pausedUntil, 'monthOnly') : '';
      vm['subscription.quantitySummary'] = sub.lines.map(function (l) {
        return l.title.replace(/ (jar|pack).*$/, '') + ' ×' + l.quantity;
      }).join(', ');
      vm['subscription.addressShort'] = sub.address.city + ', ' + sub.address.province;
      vm['subscription.addressLines'] = [
        sub.address.name,
        sub.address.line1 + (sub.address.line2 ? ', ' + sub.address.line2 : ''),
        sub.address.city + ', ' + sub.address.province + ' ' + sub.address.zip,
        sub.address.country
      ].map(function (x) { return self.escape(x); }).join('<br>');
      vm['subscription.paymentShort'] = sub.payment.brand + ' ···· ' + sub.payment.last4;
      vm['subscription.paymentBrand'] = sub.payment.brand.toUpperCase();
      vm['subscription.paymentLast4'] = sub.payment.last4;
      vm['subscription.paymentExpiry'] = sub.payment.expiry;

      vm['pricing.total'] = this.fmtMoney(sub.pricing.total);
      vm['pricing.discount'] = this.fmtMoney(sub.pricing.discount);

      vm['swap.replacing'] = sub.lines.length > 1 ? sub.lines[1].title : sub.lines[0].title;

      // Sheet-derived dates
      vm['sheet.skipToLong'] = this.fmtDate(NS.dates.addDays(sub.nextOrderDate, sub.intervalDays), 'long');
      vm['sheet.delayToLong'] = this.fmtDate(NS.dates.addDays(sub.nextOrderDate, d.delay), 'long');
      vm['sheet.pauseUntilLong'] = this.fmtDate(NS.dates.addMonths(today, d.pauseMonths), 'long');
      vm['sheet.resumeSoonLong'] = this.fmtDate(NS.dates.addDays(today, 3), 'long');

      // Quantity draft total
      var qTotal = NS.money(0, sub.currencyCode);
      sub.lines.forEach(function (l) {
        var q = d.quantities[l.id];
        if (typeof q !== 'number') q = l.quantity;
        qTotal = NS.addMoney(qTotal, NS.multiplyMoney(l.unitPrice, q));
      });
      var qDisc = NS.money(qTotal.amount * sub.discountRate, sub.currencyCode);
      vm['qty.total'] = this.fmtMoney(NS.money(qTotal.amount - qDisc.amount, sub.currencyCode));

      // Add-on total preview
      var addonTotal = sub.pricing.total;
      if (d.addonPick) {
        var preview = this.adapter.previewOneTimeItem(d.addonPick);
        if (preview) addonTotal = preview;
      }
      vm['addon.total'] = this.fmtMoney(addonTotal);
    }

    if (loy) {
      vm['loyalty.points'] = String(loy.points);
      vm['loyalty.perRenewal'] = String(loy.perRenewal);
      vm['loyalty.nextRewardAt'] = String(loy.nextRewardAt);
      vm['loyalty.nextRewardName'] = loy.nextRewardName;
      vm['loyalty.toNextReward'] = String(loy.toNextReward);
      vm['loyalty.progressPercent'] = loy.progressPercent;
    }

    vm['account.activeCount'] = sub && sub.status !== 'cancelled' ? '1 active' : '0 active';
    vm['account.inactiveCount'] = String(s.inactive.length);

    // Cancellation alternatives, matched to the chosen reason.
    var shortNext = sub ? this.fmtDate(sub.nextOrderDate, 'short') : '';
    var alts = {
      price: ['Would a longer gap help?', 'At every 90 days your cost per month drops without changing what arrives.', 'Stretch to every 90 days', 'Same jars, same subscriber price — just further apart. You can change it back at any time.', 'Change to every 90 days', 'freq90'],
      stock: ['Then skip the next one', 'Nothing has to ship until you need it. Skipping keeps your price and your place in the routine.', 'Skip ' + shortNext, "You won't be charged for that delivery. The one after it stays on schedule.", 'Skip this delivery', 'skip'],
      pet: ['Something for the other dog?', 'Max and Bella have different needs — swapping keeps the subscription useful instead of ending it.', 'Swap the products', 'Change what ships without losing your subscriber price.', 'See other products', 'swap'],
      'switch': ['Try a different VetPets jar first', 'Swapping is instant, keeps your discount, and applies from the next delivery.', 'Swap the products', 'EarWipes, GloveWipes or a smaller FreshWipes jar.', 'See other products', 'swap'],
      other: ['Before you cancel', 'Three quicker options that keep your subscriber price. Cancelling stays available below.', 'Skip ' + shortNext, 'Push the next delivery back without any charge.', 'Skip this delivery', 'skip']
    };
    var alt = alts[d.reason] || alts.other;
    vm['alt.headline'] = alt[0];
    vm['alt.body'] = alt[1];
    vm['alt.primaryTitle'] = alt[2];
    vm['alt.primaryBody'] = alt[3];
    vm['alt.primaryCta'] = alt[4];
    this._altAction = alt[5];

    // Error + success
    vm['error.reference'] = s.error ? s.error.reference : '';
    if (s.success) {
      vm['success.title'] = s.success.title;
      vm['success.body'] = s.success.body;
      vm['success.undoLabel'] = s.success.undoLabel || '';
    }

    // Button labels, including their pending variants.
    var p = s.pending;
    vm['label.sendLink'] = p === 'sendLink' ? 'Sending link…' : 'Email me a sign-in link';
    vm['label.resend'] = p === 'resend' ? 'Sending…' : 'Resend link';
    vm['label.skip'] = p === 'skip' ? 'Skipping delivery…' : 'Skip this delivery';
    vm['label.delay'] = p === 'delay' ? 'Rescheduling…' : ('Move to ' + (sub ? this.fmtDate(NS.dates.addDays(sub.nextOrderDate, d.delay), 'short') : ''));
    vm['label.freq'] = p === 'freq' ? 'Updating cadence…' : 'Save frequency';
    vm['label.pause'] = p === 'pause' ? 'Pausing…' : ('Pause for ' + d.pauseMonths + (d.pauseMonths === 1 ? ' month' : ' months'));
    vm['label.resume'] = p === 'resume' ? 'Resuming…' : 'Resume subscription';
    vm['label.qty'] = p === 'qty' ? 'Saving…' : 'Save quantities';
    vm['label.saveAddress'] = p === 'saveAddress' ? 'Saving address…' : 'Save address';
    vm['label.swap'] = p === 'swap' ? 'Swapping…' : ('Confirm swap for ' + shortNext);
    vm['label.addon'] = p === 'addon' ? 'Saving…' : 'Save changes to next delivery';
    vm['label.redirect'] = p === 'redirect' ? 'Opening…' : 'Continue to secure page';
    vm['label.cancel'] = p === 'cancel' ? 'Cancelling…' : 'Yes, cancel my subscription';
    vm['label.reactivate'] = p === 'reactivate' ? 'Reactivating…' : 'Reactivate subscription';

    return vm;
  };

  Portal.prototype.escape = function (str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  /* =================================================================
   * Render
   * ================================================================= */

  Portal.prototype.render = function () {
    var vm = this.viewModel();
    var i;

    // Text slots
    var fields = this.root.querySelectorAll('[data-spp-field]');
    for (i = 0; i < fields.length; i++) {
      var key = fields[i].getAttribute('data-spp-field');
      if (key === 'toast.message') continue;      // owned by toast()
      if (fields[i].closest('template')) continue; // list templates render separately
      if (Object.prototype.hasOwnProperty.call(vm, key)) fields[i].textContent = vm[key];
    }

    // HTML slots (trusted, escaped at build time in viewModel)
    var htmlFields = this.root.querySelectorAll('[data-spp-field-html]');
    for (i = 0; i < htmlFields.length; i++) {
      var hk = htmlFields[i].getAttribute('data-spp-field-html');
      if (htmlFields[i].closest('template')) continue;
      if (Object.prototype.hasOwnProperty.call(vm, hk)) htmlFields[i].innerHTML = vm[hk];
    }

    // aria-label slots
    var ariaFields = this.root.querySelectorAll('[data-spp-field-aria]');
    for (i = 0; i < ariaFields.length; i++) {
      var ak = ariaFields[i].getAttribute('data-spp-field-aria');
      if (Object.prototype.hasOwnProperty.call(vm, ak)) ariaFields[i].setAttribute('aria-label', vm[ak]);
    }

    // Progress widths
    var widths = this.root.querySelectorAll('[data-spp-style-width]');
    for (i = 0; i < widths.length; i++) {
      var wk = widths[i].getAttribute('data-spp-style-width');
      if (Object.prototype.hasOwnProperty.call(vm, wk)) widths[i].style.width = vm[wk] + '%';
    }

    // Status-conditional blocks. `status` is a single canonical value, so at
    // most one of these can ever be visible.
    var status = this.state.data ? this.state.data.status : 'active';
    var conds = this.root.querySelectorAll('[data-spp-when]');
    for (i = 0; i < conds.length; i++) {
      var expr = conds[i].getAttribute('data-spp-when').split(':');
      if (expr[0] === 'status') conds[i].hidden = status !== expr[1];
    }

    // Status badge tint
    var badge = this.root.querySelector('[data-spp-status-badge]');
    if (badge) {
      badge.style.background = status === 'active' ? 'var(--spp-light)' : 'var(--spp-surface-neutral)';
    }

    this.renderLists(vm);
    this.renderUndo();
  };

  Portal.prototype.renderUndo = function () {
    var btn = this.root.querySelector('[data-spp-undo]');
    if (!btn) return;
    btn.hidden = !(this.state.success && this.state.success.undo);
  };

  /* -----------------------------------------------------------------
   * Lists
   * ----------------------------------------------------------------- */

  var PENDING_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<rect x="3.2" y="5.2" width="17.6" height="13.6" rx="2.6" stroke="currentColor" stroke-width="1.6"/>' +
    '<circle cx="8.6" cy="10" r="1.6" fill="currentColor"/>' +
    '<path d="M3.6 16.4l4.6-4 3.4 3 3.2-2.6 5.4 4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  Portal.prototype.listData = function (name) {
    var s = this.state;
    var sub = s.data;
    var d = s.draft;
    var self = this;

    switch (name) {
      case 'pets':
        return (s.customer ? s.customer.pets : []).map(function (p, i) {
          return { name: p.name, initial: p.initial, _alt: i > 0 };
        });

      case 'petsFull':
        return (s.customer ? s.customer.pets : []).map(function (p, i) {
          return { initial: p.initial, nameBreed: p.name + ' · ' + p.breed, _alt: i > 0 };
        });

      case 'lineThumbs':
      case 'lineThumbs2':
        return (sub ? sub.lines : []).map(function (l) {
          return { _image: l.image, _pending: l.imagePending, _alt2: l.title };
        });

      case 'lines':
        return (sub ? sub.lines : []).map(function (l) {
          return {
            title: l.title,
            subtitle: l.subtitle,
            quantity: String(l.quantity),
            unitPrice: self.fmtMoney(l.unitPrice),
            _image: l.image,
            _pending: l.imagePending,
            _alt2: l.title
          };
        });

      case 'lineSummary':
        return (sub ? sub.lines : []).map(function (l) {
          return { title: l.title, quantity: String(l.quantity), linePrice: self.fmtMoney(l.linePrice) };
        });

      case 'qtyLines':
        return (sub ? sub.lines : []).map(function (l) {
          var q = d.quantities[l.id];
          return {
            title: l.title,
            unitPrice: self.fmtMoney(l.unitPrice),
            draftQuantity: String(typeof q === 'number' ? q : l.quantity),
            _image: l.image,
            _pending: l.imagePending,
            _alt2: l.title,
            _lineId: l.id
          };
        });

      case 'deliveriesPreview': {
        if (!s.deliveries) return [];
        var out = [];
        var up = s.deliveries.upcoming;
        out.push({
          mon: self.fmtDate(up.date, 'short').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() ||
               NS.dates.parseISO(up.date).toLocaleDateString('en', { month: 'short' }).toUpperCase(),
          day: String(NS.dates.parseISO(up.date).getDate()),
          title: up.title,
          meta: up.items,
          status: up.status
        });
        s.deliveries.past.slice(0, 2).forEach(function (o) {
          out.push({
            mon: NS.dates.parseISO(o.date).toLocaleDateString('en', { month: 'short' }).toUpperCase(),
            day: String(NS.dates.parseISO(o.date).getDate()),
            title: 'Delivered',
            meta: 'Order #' + o.orderId + ' · ' + self.fmtMoney(o.amount),
            status: 'Complete'
          });
        });
        return out;
      }

      case 'pastOrders':
        return (s.deliveries ? s.deliveries.past : []).map(function (o) {
          return {
            dateLong: self.fmtDate(o.date, 'full'),
            items: o.items,
            amount: self.fmtMoney(o.amount),
            status: o.status,
            _image: self.cfg.images.freshwipes,
            _pending: false,
            _alt2: ''
          };
        });

      case 'pointsHistory':
        return (s.loyalty ? s.loyalty.history : []).map(function (h) {
          return {
            label: h.label,
            dateLong: self.fmtDate(h.date, 'full'),
            delta: (h.delta > 0 ? '+' : '−') + Math.abs(h.delta)
          };
        });

      case 'rewards':
        return s.rewards.map(function (r) {
          return {
            name: r.name,
            cost: String(r.cost),
            btnLabel: r.affordable ? 'Redeem' : (r.pointsToGo + ' points to go'),
            _image: r.image,
            _pending: r.imagePending,
            _alt2: r.name,
            _rewardId: r.id,
            _affordable: r.affordable
          };
        });

      case 'swapOptions':
        return s.swapOptions.map(function (o, i) {
          return {
            name: o.name,
            meta: o.meta,
            price: self.fmtMoney(o.price),
            _image: o.image,
            _pending: o.imagePending,
            _alt2: o.name,
            _optionId: o.id,
            _checked: d.swapPick === i,
            _index: i
          };
        });

      case 'addonOptions':
        return s.addonOptions.map(function (o) {
          return {
            name: o.name,
            meta: o.meta,
            price: self.fmtMoney(o.price),
            btnLabel: d.addonPick === o.id ? 'Added' : 'Add',
            _image: o.image,
            _pending: o.imagePending,
            _alt2: o.name,
            _optionId: o.id
          };
        });

      case 'reasons':
        return [
          ['price', 'Too expensive'],
          ['stock', 'I still have plenty left'],
          ['pet', 'My dog no longer needs it'],
          ['switch', 'Switching to another product'],
          ['other', 'Something else']
        ].map(function (r) {
          return { label: r[1], _value: r[0], _checked: d.reason === r[0] };
        });

      case 'delayOptions':
        return [7, 15, 30].map(function (n) {
          return { label: n + ' days', _value: n, _checked: d.delay === n };
        });

      case 'freqOptions':
        return [30, 45, 60, 90].map(function (n) {
          var hint = n === 60 ? 'Your current cadence'
            : n === 30 ? 'More often'
            : n === 45 ? 'Slightly more often' : 'Fewer deliveries';
          return { label: 'Every ' + n + ' days', hint: hint, _value: n, _checked: d.freq === n };
        });

      case 'pauseOptions':
        return [1, 2, 3].map(function (n) {
          return { n: String(n), unit: n === 1 ? 'month' : 'months', _value: n, _checked: d.pauseMonths === n };
        });

      case 'restartDates':
        return [
          ['As soon as possible', 0], ['In two weeks', 14], ['In a month', 30]
        ].map(function (r, i) {
          return { label: r[0], _value: r[1], _checked: d.restart === i, _index: i };
        });

      case 'inactiveSubs':
        return s.inactive.map(function (x) {
          return {
            reference: x.reference,
            statusLabel: x.status === 'cancelled' ? 'Cancelled' : 'Completed',
            name: x.name,
            meta: x.meta,
            _image: x.image,
            _pending: false,
            _alt2: x.name
          };
        });

      case 'cancelFacts': {
        if (!sub) return [];
        return [
          'Your ' + self.fmtDate(sub.nextOrderDate, 'short') + ' delivery will not ship.',
          'No further charges will be made to ' + sub.payment.brand + ' ···· ' + sub.payment.last4 + '.',
          'Your ' + (s.loyalty ? s.loyalty.points : 0) + ' VetPoints stay on the account for 12 months.',
          'You can reactivate with the same products and price at any time.'
        ].map(function (t) { return { text: t }; });
      }

      default:
        return [];
    }
  };

  Portal.prototype.renderLists = function () {
    var hosts = this.root.querySelectorAll('[data-spp-list]');
    for (var h = 0; h < hosts.length; h++) {
      var host = hosts[h];
      var name = host.getAttribute('data-spp-list');
      var tpl = host.querySelector('[data-spp-tpl="' + name + '"]');
      if (!tpl) continue;

      var items = this.listData(name);
      var withSeparators = host.hasAttribute('data-spp-separators');

      // Clear previously rendered nodes but keep the <template>.
      var kids = Array.prototype.slice.call(host.children);
      for (var k = 0; k < kids.length; k++) {
        if (kids[k] !== tpl) host.removeChild(kids[k]);
      }

      for (var i = 0; i < items.length; i++) {
        if (withSeparators && i > 0) {
          var hr = document.createElement('div');
          hr.style.cssText = 'height:1px;background:rgba(13,35,64,.09);';
          host.appendChild(hr);
        }
        var node = tpl.content.firstElementChild.cloneNode(true);
        this.fillNode(node, items[i], name, i);
        host.appendChild(node);
      }
    }
  };

  Portal.prototype.fillNode = function (node, item, listName, index) {
    var i;

    // text slots
    var fields = node.querySelectorAll('[data-spp-field]');
    for (i = 0; i < fields.length; i++) {
      var key = fields[i].getAttribute('data-spp-field');
      if (Object.prototype.hasOwnProperty.call(item, key)) fields[i].textContent = item[key];
    }
    if (node.hasAttribute && node.hasAttribute('data-spp-field')) {
      var rk = node.getAttribute('data-spp-field');
      if (Object.prototype.hasOwnProperty.call(item, rk)) node.textContent = item[rk];
    }

    // image / pending placeholder
    var thumb = node.matches && node.matches('[data-spp-thumb]') ? node : node.querySelector('[data-spp-thumb]');
    if (thumb) {
      var img = thumb.querySelector('[data-spp-img]');
      if (item._pending) {
        thumb.classList.add('spp__thumb--pending');
        thumb.innerHTML = PENDING_SVG;
        thumb.setAttribute('role', 'img');
        thumb.setAttribute('aria-label', (item._alt2 || 'Product') + ' — packshot photo pending');
      } else if (img) {
        if (item._image) {
          img.src = item._image;
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
        } else {
          img.remove();
        }
      }
    }

    // selection state
    if (typeof item._checked === 'boolean') {
      var pick = node.matches && node.matches('[data-spp-pick]') ? node : node.querySelector('[data-spp-pick]');
      if (pick) {
        pick.setAttribute('aria-checked', item._checked ? 'true' : 'false');
        pick.classList.toggle('is-selected', item._checked);
      }
    }

    // stash identifiers the click handlers need
    var carriers = node.querySelectorAll('[data-spp-pick], [data-spp-act], [data-spp-qty]');
    var all = Array.prototype.slice.call(carriers);
    if (node.matches && (node.matches('[data-spp-pick]') || node.matches('[data-spp-act]'))) all.push(node);
    for (i = 0; i < all.length; i++) {
      if (item._value !== undefined) all[i].dataset.sppValue = item._value;
      if (item._optionId) all[i].dataset.sppOption = item._optionId;
      if (item._rewardId) all[i].dataset.sppReward = item._rewardId;
      if (item._lineId) all[i].dataset.sppLine = item._lineId;
      if (item._index !== undefined) all[i].dataset.sppIndex = item._index;
      all[i].dataset.sppListIndex = index;
    }

    // alt-styled chip dot for the second pet
    if (item._alt) {
      var dot = node.querySelector('.spp__chip-dot');
      if (dot) dot.classList.add('spp__chip-dot--alt');
    }

    // reward affordability
    if (listName === 'rewards') {
      var btn = node.querySelector('[data-spp-act="redeem"]');
      if (btn) {
        if (item._affordable) {
          // Redeemable rewards are solid blue primaries — same token set,
          // white foreground, no exceptions.
          btn.classList.add('spp__btn--primary');
          btn.style.background = '';
          btn.style.color = '';
        } else {
          btn.classList.remove('spp__btn--primary');
          btn.style.background = 'var(--spp-surface-neutral)';
          btn.style.color = 'var(--spp-muted)';
          btn.setAttribute('aria-disabled', 'true');
        }
      }
    }

    // quantity stepper bounds
    if (listName === 'qtyLines') {
      var out = node.querySelector('output');
      var val = parseInt(item.draftQuantity, 10);
      var minus = node.querySelector('[data-spp-qty="minus"]');
      var plus = node.querySelector('[data-spp-qty="plus"]');
      if (minus) minus.disabled = val <= 0;
      if (plus) plus.disabled = val >= 50;
      if (out) out.setAttribute('aria-label', item.title + ' quantity');
    }
  };

  /* =================================================================
   * Events
   * ================================================================= */

  Portal.prototype.bind = function () {
    var self = this;

    this.root.addEventListener('click', function (e) {
      var el;

      if ((el = e.target.closest('[data-spp-go]'))) {
        e.preventDefault();
        self.show(el.getAttribute('data-spp-go'));
        return;
      }
      if ((el = e.target.closest('[data-spp-sheet]'))) {
        e.preventDefault();
        self.openSheet(el.getAttribute('data-spp-sheet'));
        return;
      }
      if ((el = e.target.closest('[data-spp-qty]'))) {
        e.preventDefault();
        self.stepQuantity(el);
        return;
      }
      if ((el = e.target.closest('[data-spp-pick]'))) {
        e.preventDefault();
        self.pick(el);
        return;
      }
      if ((el = e.target.closest('[data-spp-act]'))) {
        e.preventDefault();
        if (el.getAttribute('aria-disabled') === 'true') return;
        self.act(el.getAttribute('data-spp-act'), el);
        return;
      }
      if ((el = e.target.closest('[data-spp-dev-toggle]'))) {
        var panel = el.closest('[data-spp-dev]');
        var collapsed = panel.getAttribute('data-collapsed') === 'true';
        panel.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
        return;
      }
      if ((el = e.target.closest('[data-spp-dev-status]'))) {
        self.adapter.setStatus(el.getAttribute('data-spp-dev-status')).then(function (sub) {
          self.state.data = sub;
          self.show('dashboard');
        });
        return;
      }
      if ((el = e.target.closest('[data-spp-dev-pending]'))) {
        self.openSheet('skip');
        self.state.pending = 'skip';
        self.applyPending(true);
        self.render();
        return;
      }
      // Click on the overlay backdrop closes the sheet.
      if (e.target.hasAttribute && e.target.hasAttribute('data-spp-overlay')) {
        self.closeSheet();
      }
    });

    this.root.addEventListener('change', function (e) {
      var sel = e.target.closest('[data-spp-dev-currency]');
      if (!sel) return;
      self.adapter.setCurrency(sel.value).then(function () { return self.load(); });
    });

    this.root.addEventListener('submit', function (e) {
      var form = e.target.closest('form[data-spp-form]');
      if (!form) return;
      e.preventDefault();
      if (form.getAttribute('data-spp-form') === 'login') self.act('sendLink', form);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self.state.sheet && !self.state.pending) {
        self.closeSheet();
        return;
      }
      if (e.key === 'Tab' && self.state.sheet) self.trapFocus(e);
    });
  };

  Portal.prototype.trapFocus = function (e) {
    var host = this.root.querySelector('[data-spp-sheet-host]');
    if (!host) return;
    var f = this.focusablesIn(host);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  Portal.prototype.stepQuantity = function (el) {
    var lineId = el.dataset.sppLine;
    if (!lineId) return;
    var dir = el.getAttribute('data-spp-qty') === 'plus' ? 1 : -1;
    var cur = this.state.draft.quantities[lineId];
    if (typeof cur !== 'number') cur = 0;
    this.state.draft.quantities[lineId] = Math.max(0, Math.min(50, cur + dir));
    this.render();
  };

  Portal.prototype.pick = function (el) {
    var kind = el.getAttribute('data-spp-pick');
    var d = this.state.draft;
    var value = el.dataset.sppValue;

    if (kind === 'delay') d.delay = parseInt(value, 10);
    else if (kind === 'freq') d.freq = parseInt(value, 10);
    else if (kind === 'pause') d.pauseMonths = parseInt(value, 10);
    else if (kind === 'reason') d.reason = value;
    else if (kind === 'restart') d.restart = parseInt(el.dataset.sppIndex, 10);
    else if (kind === 'swap') d.swapPick = parseInt(el.dataset.sppIndex, 10);
    else if (kind === 'addon') {
      var opt = el.dataset.sppOption;
      d.addonPick = d.addonPick === opt ? null : opt;
    }
    this.render();
  };

  /* -----------------------------------------------------------------
   * Actions
   * ----------------------------------------------------------------- */

  Portal.prototype.act = function (name, el) {
    var self = this;
    var s = this.state;
    var d = s.draft;
    var sub = s.data;
    var id = sub ? sub.id : null;

    switch (name) {

      case 'close':
        this.closeSheet();
        return;

      case 'sendLink': {
        var input = this.root.querySelector('#spp-email');
        var err = this.root.querySelector('[data-spp-error="login"]');
        var value = input ? input.value.trim() : '';
        if (!value || value.indexOf('@') === -1) {
          if (err) { err.textContent = 'Enter the email address you used at checkout.'; err.hidden = false; }
          if (input) input.focus();
          return;
        }
        if (err) err.hidden = true;
        this.run('sendLink', function () { return self.adapter.requestMagicLink(value); }, {
          closeSheet: false,
          then: function () {
            return self.adapter.getCustomer().then(function (c) {
              self.state.customer = c;
              self.show('sent');
            });
          }
        });
        return;
      }

      case 'openLink':
        this.show('loading');
        this.load().then(function () { self.show('dashboard'); }).catch(function (e) { self.fail(e); });
        return;

      case 'resend':
        this.run('resend', function () { return self.adapter.requestMagicLink(s.customer ? s.customer.email : ''); }, {
          closeSheet: false,
          then: function () { self.show('sent'); },
          toast: 'New sign-in link sent'
        });
        return;

      case 'retry':
        this.state.error = null;
        this.show('loading');
        this.load().then(function () { self.show('dashboard'); }).catch(function (e) { self.fail(e); });
        return;

      case 'skip': {
        var before = sub.nextOrderDate;
        this.run('skip', function () { return self.adapter.skipNextDelivery(id); }, {
          success: function (st) {
            return {
              title: 'Delivery skipped',
              body: 'Nothing ships on ' + self.fmtDate(before, 'full') +
                    ' and you won\'t be charged. Your next delivery is <strong style="color:var(--spp-ink);">' +
                    self.fmtDate(st.data.nextOrderDate, 'long') + '</strong>.',
              undo: true,
              undoLabel: 'Undo skip',
              undoTo: before
            };
          }
        });
        return;
      }

      case 'undo': {
        var target = s.success && s.success.undoTo;
        if (!target) return;
        this.run('undo', function () { return self.adapter.rescheduleNextDelivery(id, target); }, {
          then: function () { self.state.success = null; self.show('dashboard'); },
          toast: 'Skip undone'
        });
        return;
      }

      case 'delay':
        this.run('delay', function () { return self.adapter.delayNextDelivery(id, d.delay); }, {
          then: function (st) { self.show('dashboard'); },
          toast: function (st) { return 'Delivery moved to ' + self.fmtDate(st.data.nextOrderDate, 'short'); }
        });
        return;

      case 'freq':
        this.run('freq', function () { return self.adapter.setFrequency(id, d.freq); }, {
          then: function () { self.render(); },
          toast: function (st) { return 'Now delivering every ' + st.data.intervalDays + ' days'; }
        });
        return;

      case 'pause':
        this.run('pause', function () { return self.adapter.pause(id, d.pauseMonths); }, {
          then: function () { self.show('dashboard'); },
          toast: function (st) { return 'Paused until ' + self.fmtDate(st.data.pausedUntil, 'short'); }
        });
        return;

      case 'resume':
        this.run('resume', function () { return self.adapter.resume(id); }, {
          then: function () { self.show('dashboard'); },
          toast: 'Subscription resumed'
        });
        return;

      case 'qty':
        this.run('qty', function () { return self.adapter.setQuantities(id, d.quantities); }, {
          then: function () { self.render(); },
          toast: 'Quantities updated'
        });
        return;

      case 'swap': {
        var opt = this.state.swapOptions[d.swapPick];
        if (!opt) return;
        this.run('swap', function () { return self.adapter.swapProduct(id, opt.id); }, {
          then: function () { self.show('subscription'); },
          toast: function (st) { return 'Product swapped from ' + self.fmtDate(st.data.nextOrderDate, 'short'); }
        });
        return;
      }

      case 'addon': {
        if (!d.addonPick) {
          this.toast('Pick an item to add first');
          return;
        }
        var pick = d.addonPick;
        this.run('addon', function () { return self.adapter.addOneTimeItem(id, pick); }, {
          then: function () { self.show('dashboard'); },
          toast: function (st) { return 'One-time item added to ' + self.fmtDate(st.data.nextOrderDate, 'short'); }
        });
        return;
      }

      case 'saveAddress': {
        var form = this.root.querySelector('form[data-spp-form="address"]');
        var payload = {};
        if (form) {
          ['name', 'line1', 'line2', 'city', 'province', 'zip', 'phone'].forEach(function (k) {
            var f = form.querySelector('[name="' + k + '"]');
            if (f) payload[k] = f.value.trim();
          });
        }
        this.run('saveAddress', function () { return self.adapter.updateAddress(id, payload); }, {
          then: function () { self.show('account'); },
          toast: 'Delivery address updated'
        });
        return;
      }

      case 'redirect':
        this.run('redirect', function () { return self.adapter.createPaymentUpdateSession(id); }, {
          then: function () { self.show('dashboard'); },
          toast: 'Card updated on secure page'
        });
        return;

      case 'redeem': {
        var rewardId = el && el.dataset.sppReward;
        if (!rewardId || el.getAttribute('aria-disabled') === 'true') return;
        this.run('redeem', function () { return self.adapter.redeemReward(rewardId); }, {
          closeSheet: false,
          then: function () {
            return self.adapter.listRewards().then(function (r) {
              self.state.rewards = r;
              self.render();
            });
          },
          toast: 'Reward added to your next delivery'
        });
        return;
      }

      case 'altPrimary': {
        var action = this._altAction;
        if (action === 'freq90') { this.state.draft.freq = 90; this.openSheet('freq'); }
        else if (action === 'skip') this.openSheet('skip');
        else if (action === 'swap') this.show('swap');
        return;
      }

      case 'cancel':
        this.run('cancel', function () { return self.adapter.cancel(id, d.reason); }, {
          then: function () { self.show('cancel-done'); }
        });
        return;

      case 'reactivate': {
        var offsets = [0, 14, 30];
        var days = offsets[d.restart] || 0;
        this.run('reactivate', function () { return self.adapter.reactivate(id, days); }, {
          then: function () { self.show('dashboard'); },
          toast: 'Subscription reactivated'
        });
        return;
      }

      case 'signOut':
        this.adapter.signOut().then(function () { self.show('login'); });
        return;

      case 'support':
      case 'faq':
        this.toast('Support is not wired up in this prototype');
        return;
    }
  };

  /* =================================================================
   * Init
   * ================================================================= */

  function init() {
    var roots = document.querySelectorAll('[data-spp-portal]');
    for (var i = 0; i < roots.length; i++) {
      if (!roots[i].__sppBooted) {
        roots[i].__sppBooted = true;
        new Portal(roots[i]);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-init inside the theme editor when the section is reloaded.
  document.addEventListener('shopify:section:load', init);
})(window, document);
