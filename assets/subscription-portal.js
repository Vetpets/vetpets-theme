/*
 * VetPets Subscription Portal — UI controller
 * ------------------------------------------------------------------
 * Owns navigation, rendering, sheets, pending/toast/error states and
 * focus management. It never fetches and never formats currency on its
 * own — everything comes from the adapter, so replacing the mock with
 * the live backend requires no change in this file.
 *
 * Scope is the Phoenix-supported surface: skip, delay/reschedule, cancel
 * and reactivate. Quantity, swap, one-time item, address, card and
 * frequency/pause/resume are not portal capabilities and have no code
 * path here.
 */
(function (window, document) {
  'use strict';

  var NS = window.VetPetsPortal;
  if (!NS) return;

  var SCREENS_WITH_CHROME = {
    login: false, sent: false, expired: false, loading: false, error: false
  };

  /**
   * Failures that mean "you are not signed in", not "your subscription could
   * not be loaded".
   *
   * These must always land on the clean sign-in screen. Rendering them as the
   * error screen produced a SUB-503 reference for what was simply an expired
   * or absent session — a support code pointing at Phoenix for a problem one
   * tap could fix, and a customer with no way to fix it.
   */
  var AUTH_FAILURE_CODES = {
    unauthenticated: true,
    expired_link: true,
    no_subscription: true
  };

  function Portal(root) {
    this.root = root;
    this.cfg = this.readConfig(root);

    // createAdapter refuses to hand back mock data in live mode, so a
    // fabricated VetPoints balance can never reach a real customer.
    try {
      this.adapter = NS.createAdapter({
        mode: this.cfg.mode,
        basePath: this.cfg.basePath,
        // Live counts from the real calendar day. `cfg.today` is the
        // prototype's frozen date (2026-08-21) and may only reach the mock
        // adapter — it is what rendered "34 days away" for a delivery 25 days
        // out. Local date, not UTC: a customer counts sleeps, not hours.
        today: this.cfg.mode === 'live' ? NS.dates.toISO(new Date()) : this.cfg.today,
        currencyCode: this.cfg.currency,
        latency: this.cfg.latency,
        pointsPerRenewal: this.cfg.pointsPerRenewal,
        nextRewardAt: this.cfg.nextRewardAt,
        nextRewardName: this.cfg.nextRewardName,
        images: this.cfg.images
      });
    } catch (e) {
      this.adapter = null;
      this.bootError = e;
    }

    this.state = {
      screen: 'loading',
      sheet: null,
      pending: null,
      lastFocus: null,
      draft: { delay: 7, reason: 'price', restart: 0, date: null },
      data: null,
      loyalty: null,
      customer: null,
      inactive: [],
      deliveries: null,
      rewards: [],
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
      mode: d.sppMode === 'live' ? 'live' : 'mock',
      basePath: d.sppBasePath || '/apps/subscriptions',
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
   * Formatting (locale aware — never hardcodes a symbol)
   * ================================================================= */

  Portal.prototype.fmtMoney = function (value) { return NS.formatMoney(value, this.cfg.locale); };

  /**
   * The window the BACKEND will accept for a rescheduled delivery.
   *
   * Mirrored from the route rather than invented here: it refuses a date
   * before today or more than a year out. Both bounds are computed in UTC,
   * exactly as the server does, so the picker can never offer a date the
   * server would then reject — a customer choosing a date and being told no
   * is a worse experience than not being offered it.
   */
  var MAX_RESCHEDULE_DAYS = 365;

  Portal.prototype.rescheduleBounds = function () {
    var today = new Date().toISOString().slice(0, 10);
    return { min: today, max: NS.dates.addDays(today, MAX_RESCHEDULE_DAYS) };
  };

  /** Is the custom-date option the one currently chosen? */
  Portal.prototype.isCustomDate = function () {
    return this.state.draft.delay === 'custom';
  };

  /**
   * The date this sheet would move the delivery to, or null when the customer
   * has chosen "another date" and not yet picked one.
   */
  Portal.prototype.delayTargetIso = function () {
    var sub = this.state.data;
    if (!sub || !sub.nextOrderDate) return null;
    if (this.isCustomDate()) return this.state.draft.date || null;
    return NS.dates.addDays(sub.nextOrderDate, this.state.draft.delay);
  };

  /**
   * Why the chosen date cannot be submitted, or null when it can.
   *
   * Checked here as well as on the server. The server is the authority — this
   * exists so the customer is told immediately and in their own terms, not
   * after a round trip that reads like a failure.
   */
  Portal.prototype.rescheduleError = function () {
    if (!this.isCustomDate()) return null;

    var sub = this.state.data;
    var chosen = this.state.draft.date;
    if (!chosen) return 'Choose a date for your next delivery.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(chosen)) return 'That date could not be read.';

    var b = this.rescheduleBounds();
    if (chosen < b.min) return 'Choose a date from today onwards.';
    if (chosen > b.max) return 'Choose a date within the next year.';
    if (sub && chosen === sub.nextOrderDate) return 'That is already your delivery date.';
    return null;
  };

  Portal.prototype.fmtDate = function (iso, style) {
    if (!iso) return '';
    var date = NS.dates.parseISO(iso);
    var opts;
    if (style === 'long') opts = { weekday: 'long', month: 'long', day: 'numeric' };
    else if (style === 'medium') opts = { weekday: 'short', month: 'short', day: 'numeric' };
    else if (style === 'short') opts = { month: 'short', day: 'numeric' };
    else if (style === 'full') opts = { day: 'numeric', month: 'long', year: 'numeric' };
    else opts = { month: 'short', day: 'numeric' };
    try { return new Intl.DateTimeFormat(this.cfg.locale, opts).format(date); }
    catch (e) { return iso; }
  };

  /* =================================================================
   * Boot
   * ================================================================= */

  Portal.prototype.boot = function () {
    var self = this;
    var params = new URLSearchParams(window.location.search);

    // Review tools are mock-mode only — never expose them in production.
    // spp_dev=1 reveals the switcher; it can never switch the data mode.
    if ((params.get('spp_dev') === '1' || this.cfg.devDefault) && this.cfg.mode === 'mock') {
      this.root.classList.add('is-dev');
      var dev = this.root.querySelector('[data-spp-dev]');
      if (dev) dev.hidden = false;
    }

    // In live mode, wipe every static design placeholder before anything
    // renders. The markup ships with prototype values ("640" VetPoints,
    // "$62.73", "Visa ···· 4242") purely so the design reviews without JS.
    // A real customer must never see a fabricated number, not even briefly
    // and not merely hidden behind another screen.
    if (this.cfg.mode === 'live') this.clearPlaceholders();

    this.show('loading');

    if (!this.adapter) { this.fail(this.bootError); return; }

    var start = this.cfg.mode === 'mock' ? params.get('spp_screen') : null;

    if (this.cfg.mode === 'live') { this.bootLive(start); return; }

    var token = params.get('spp_token');

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

  /**
   * Live boot — the cookie-free handoff.
   *
   * Order is load-bearing. The handoff code is taken out of the address bar
   * FIRST, before any await and before anything else on the page can read
   * `location.search`, because a URL reaches history, `Referer` and analytics.
   * Only then is it exchanged for the session.
   *
   * Three entry paths:
   *   - arriving from the emailed link, carrying a handoff;
   *   - reloading the tab with a session already in sessionStorage;
   *   - arriving cold, which is the sign-in screen.
   */
  Portal.prototype.bootLive = function (start) {
    var self = this;

    // Synchronous and first. Nothing may await before this returns.
    var handoff = NS.takeHandoffFromUrl();

    function loadAndShow() {
      return self.load().then(function () { self.show(start || 'dashboard'); });
    }

    // One handler, shared with retry and every action: fail() itself decides
    // sign-in versus error screen. Keeping that rule in a single place is what
    // stops the two paths from disagreeing.
    function onFailure(err) {
      self.fail(err);
    }

    if (handoff) {
      this.adapter.exchangeHandoff(handoff)
        .then(loadAndShow)
        .catch(onFailure);
      return;
    }

    // A reload in the same tab reuses the unexpired session; closing the tab
    // ends it, because sessionStorage does.
    if (this.adapter.hasSession && this.adapter.hasSession()) {
      loadAndShow().catch(onFailure);
      return;
    }

    this.show('login');
  };

  /**
   * Blank every data slot in the document, including the ones inside list
   * <template> elements, so no prototype value survives into production.
   */
  Portal.prototype.clearPlaceholders = function () {
    var i;
    var slots = this.root.querySelectorAll('[data-spp-field], [data-spp-field-html]');
    for (i = 0; i < slots.length; i++) slots[i].textContent = '';

    var tpls = this.root.querySelectorAll('template[data-spp-tpl]');
    for (i = 0; i < tpls.length; i++) {
      var inner = tpls[i].content.querySelectorAll('[data-spp-field], [data-spp-field-html]');
      for (var j = 0; j < inner.length; j++) inner[j].textContent = '';
    }

    // Form fields, which are NOT [data-spp-field] slots and so survived the
    // loop above. The sign-in input once shipped with a prototype address in
    // its `value`, and a real customer had to delete a stranger's email before
    // typing their own. The markup no longer carries one; this makes it
    // impossible for any future markup to reintroduce it in live mode.
    var inputs = this.root.querySelectorAll('input[type="email"], input[type="text"], textarea');
    for (i = 0; i < inputs.length; i++) {
      if (inputs[i].value) inputs[i].value = '';
      inputs[i].removeAttribute('value');
    }

    // Prototype affordances. Removed outright rather than hidden: a control a
    // real customer must never reach should not exist in the document.
    var mockOnly = this.root.querySelectorAll('[data-spp-mock-only]');
    for (i = 0; i < mockOnly.length; i++) {
      if (mockOnly[i].parentNode) mockOnly[i].parentNode.removeChild(mockOnly[i]);
    }
  };

  /**
   * Is there anything to read the portal WITH?
   *
   * In live mode every portal read needs a session. Asking without one is not
   * a server error to be reported — it is the sign-in screen.
   */
  Portal.prototype.hasSession = function () {
    if (this.cfg.mode !== 'live') return true;
    return !!(this.adapter && this.adapter.hasSession && this.adapter.hasSession());
  };

  /** Drop whatever this browser is holding. Local only; no request. */
  Portal.prototype.clearSessionLocally = function () {
    if (this.adapter && this.adapter.clearSession) {
      try { this.adapter.clearSession(); } catch (e) { /* nothing to clear */ }
    }
  };

  Portal.prototype.load = function () {
    var self = this;

    // Guard the whole authenticated surface in one place, so no caller can
    // reach it before a handoff has been exchanged.
    if (!this.hasSession()) {
      return Promise.reject(NS.PortalError('unauthenticated', 'Sign in to view your subscription.'));
    }

    return Promise.all([
      this.adapter.getCustomer(),
      this.adapter.getSubscription(),
      this.adapter.getLoyalty(),
      this.adapter.listSubscriptions(),
      this.adapter.listDeliveries(),
      this.adapter.listRewards()
    ]).then(function (r) {
      self.state.customer = r[0];
      self.state.data = r[1];
      self.state.loyalty = r[2];
      self.state.inactive = r[3].inactive;
      self.state.deliveries = r[4];
      self.state.rewards = r[5];
      self.render();
    });
  };

  /**
   * The ONE place a failure becomes a screen.
   *
   * Boot, retry and every action funnel through here, so the rule cannot be
   * true on one path and false on another — which is exactly how a 401 came to
   * be rendered as SUB-503 from the retry button but as the login screen from
   * boot.
   */
  Portal.prototype.fail = function (err) {
    if (err && AUTH_FAILURE_CODES[err.code]) {
      // Not signed in. Drop the dead token so the next attempt starts clean,
      // and show sign-in rather than an error the customer cannot act on.
      this.clearSessionLocally();
      this.state.error = null;
      this.state.pending = null;
      this.show('login');
      return;
    }

    this.state.error = {
      code: (err && err.code) || 'server',
      reference: (err && err.reference) || this.buildReference(err)
    };
    this.render();
    this.show('error');
  };

  /**
   * A support reference for the error screen.
   *
   * In live mode the stamp is the REAL current date. `cfg.today` is the
   * prototype's frozen date and belongs to mock mode only — stamping it on a
   * real customer's error produced a reference dated August 21, 2026 no matter
   * when the failure happened, which is worse than useless to support.
   *
   * The code is a coarse class, never the upstream message: the server
   * deliberately withholds that, and repeating a guess here would undo it.
   */
  Portal.prototype.buildReference = function (err) {
    var code = (err && err.code) || 'server';
    var stamp = this.cfg.mode === 'live'
      ? this.fmtDate(NS.dates.toISO(new Date()), 'full')
      : this.fmtDate(this.cfg.today, 'full');

    // SUB-503 is reserved for a genuine failure of an AUTHENTICATED read.
    // fail() already routes auth failures to sign-in, so this branch should be
    // unreachable — it exists so that if a new path ever forgets, the customer
    // and support see an authentication code rather than a Phoenix one.
    var prefix;
    if (AUTH_FAILURE_CODES[code]) prefix = 'SUB-AUTH';
    else if (code === 'network') prefix = 'SUB-000';
    else if (code === 'mock_in_production') prefix = 'SUB-CFG';
    else prefix = 'SUB-503';

    return prefix + ' · ' + stamp;
  };

  /* =================================================================
   * Navigation
   * ================================================================= */

  Portal.prototype.show = function (screen) {
    if (this.state.screen !== screen) this.state.history.push(this.state.screen);
    this.state.screen = screen;
    this.closeSheet(true);

    /* ONE CONFIRMATION, AT MOST ONE MUTATION — re-armed here.
     *
     * THE DEFECT THIS LINE EXISTS FOR
     * -------------------------------
     * The guard was originally re-armed only by openSheet(), because skip and
     * delay are sheets. Cancel and reactivate are not: they are SCREENS,
     * reached with data-spp-go. So after any sheet mutation the flag stayed
     * spent, and every later press of "Yes, cancel my subscription" hit the
     * guard and returned — no request, no spinner, no error, nothing. The
     * button was dead, and looked it.
     *
     * Arriving at a new screen is a fresh confirmation exactly as opening a
     * sheet is. Navigation is the customer asking again.
     */
    this.state.confirmSpent = false;

    var sections = this.root.querySelectorAll('[data-spp-screen]');
    for (var i = 0; i < sections.length; i++) {
      sections[i].hidden = sections[i].getAttribute('data-spp-screen') !== screen;
    }

    var showChrome = SCREENS_WITH_CHROME[screen] !== false;
    var chrome = this.root.querySelectorAll('[data-spp-chrome]');
    for (var j = 0; j < chrome.length; j++) chrome[j].hidden = !showChrome;

    this.markCurrentNav(screen);
    this.render();

    var main = this.root.querySelector('#spp-main');
    if (main) {
      main.scrollTop = 0;
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
      if (navs[i].getAttribute('data-spp-nav') === screen) navs[i].setAttribute('aria-current', 'page');
      else navs[i].removeAttribute('aria-current');
    }
    var devBtns = this.root.querySelectorAll('[data-spp-dev] [data-spp-go]');
    for (var k = 0; k < devBtns.length; k++) {
      if (devBtns[k].getAttribute('data-spp-go') === screen) devBtns[k].setAttribute('aria-current', 'true');
      else devBtns[k].removeAttribute('aria-current');
    }
  };

  /* =================================================================
   * Sheets — skip and delay only
   * ================================================================= */

  Portal.prototype.openSheet = function (name) {
    var overlay = this.root.querySelector('[data-spp-overlay]');
    var host = this.root.querySelector('[data-spp-sheet-host]');
    if (!overlay || !host) return;
    if (name !== 'skip' && name !== 'delay') return;

    this.state.lastFocus = document.activeElement;
    this.state.sheet = name;

    // Opening the sheet is a fresh confirmation. See show() for the other
    // way a customer arrives at one.
    this.state.confirmSpent = false;

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
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () { el.hidden = true; }, 3600);
  };

  /* =================================================================
   * Mutation runner
   * ================================================================= */

  /**
   * Outcomes that leave the result genuinely UNKNOWN.
   *
   * After one of these the attempt key is KEPT, so that if the customer tries
   * again the server recognises the retry and replays it instead of issuing a
   * second write. Every other outcome is definitive and releases the key.
   */
  var INDETERMINATE = { timeout: 1, network: 1 };

  /**
   * One key for one logical attempt.
   *
   * The key identifies the customer's INTENTION, not the HTTP request that
   * carries it. Minting a fresh key per call is what allowed one confirmation
   * to become two independently keyed skips: the server saw two unrelated
   * operations because, as far as the keys were concerned, they were.
   *
   * The same key therefore survives a rerender, a repeated handler, a retry
   * and a delayed interaction. It is released only when the server has given a
   * definitive answer, or when fresh portal state has been loaded.
   */
  Portal.prototype.attemptKey = function (op) {
    if (!this.state.attempts) this.state.attempts = {};
    if (!this.state.attempts[op]) {
      var random = 'xxxxxxxxxxxx'.replace(/x/g, function () {
        return Math.floor(Math.random() * 16).toString(16);
      });
      this.state.attempts[op] = 'vp-' + Date.now().toString(36) + '-' + random;
    }
    return this.state.attempts[op];
  };

  /** Definitive answer received: the next attempt is a new intention. */
  Portal.prototype.releaseAttempt = function (op) {
    if (this.state.attempts) delete this.state.attempts[op];
  };

  /** Fresh state loaded: nothing in flight can still be meaningful. */
  Portal.prototype.releaseAllAttempts = function () {
    this.state.attempts = {};
  };

  Portal.prototype.run = function (key, work, opts) {
    var self = this;
    opts = opts || {};
    if (this.state.pending) return Promise.resolve();

    // Synchronous, before a single await: by the time any other handler can
    // run, the controls are disabled and the guard is set.
    this.state.pending = key;
    this.applyPending(true);
    this.render();

    // `attempt` names the logical operation for keyed actions. work() receives
    // the key so every call for one intention carries the same one.
    var op = opts.attempt || null;
    var attemptKey = op ? this.attemptKey(op) : null;

    return work(attemptKey)
      .then(function (result) {
        self.state.pending = null;
        self.applyPending(false);
        // The server answered. Whatever the customer does next is a new
        // intention and deserves a new key.
        if (op) self.releaseAttempt(op);

        if (result && result.id) self.state.data = result;

        // THE BUG THIS GUARD EXISTS FOR:
        //
        // run() was written for subscription mutations, which must re-read the
        // subscription afterwards. `sendLink` and `resend` also use run(), so a
        // SUCCESSFUL request for a magic link immediately performed three
        // authenticated portal reads — before any link had been opened, before
        // any handoff existed and before any session existed. The reads failed
        // as `unauthenticated`, the catch below called fail(), and the customer
        // saw SUB-503 instead of "Check your inbox".
        //
        // Authentication actions pass refresh:false. There is nothing to
        // refresh: by definition there is no session yet.
        var refreshed = opts.refresh === false
          ? Promise.resolve()
          : self.refreshAuthenticatedData();

        return refreshed.then(function () {
          // The sheet always closes on success, before anything renders.
          if (opts.closeSheet !== false) self.closeSheet();

          // The write applied but the server could not re-read Phoenix. The
          // change is REAL, so it is never reported as a failure — the
          // customer is told it worked and asked to refresh, rather than told
          // nothing happened and tempted to do it twice.
          if (result && result.refreshRequired) {
            self.render();
            self.refreshRequired();
            return;
          }

          if (opts.success) {
            self.state.success = opts.success(self.state, result);
            self.show('success');
          } else if (opts.then) {
            opts.then(self.state, result);
          } else {
            self.render();
          }
          if (opts.toast) self.toast(typeof opts.toast === 'function' ? opts.toast(self.state, result) : opts.toast);
        });
      })
      .catch(function (err) {
        self.state.pending = null;
        self.applyPending(false);
        self.closeSheet(true);

        // A definitive refusal frees the key. A timeout or a dropped
        // connection does NOT: the operation may well have applied, so a
        // retry has to arrive under the same key for the server to recognise
        // it rather than perform the change a second time.
        //
        // The same rule re-arms the confirmation. Nothing was applied, so the
        // customer is entitled to try again on the screen they are already
        // looking at — without it, a single network blip would leave them
        // pressing a button that silently refuses, which is the failure this
        // whole guard was rewritten to prevent.
        if (op && !INDETERMINATE[err && err.code]) {
          self.releaseAttempt(op);
          self.state.confirmSpent = false;
        }

        // A FAILED ACTION IS NOT A FAILED PAGE.
        //
        // This used to call fail(), which replaced the whole dashboard with
        // the full-page error screen. The first real skip did exactly that:
        // the customer confirmed, the operation failed, and their entire
        // subscription vanished behind "We couldn't load your subscription /
        // SUB-503" — even though the subscription had loaded perfectly a
        // moment earlier and nothing about it had changed.
        //
        // The dashboard stays. Only an authentication failure may take over
        // the page, because then there is genuinely nothing to show.
        if (err && AUTH_FAILURE_CODES[err.code]) {
          self.fail(err);
          return;
        }
        self.actionFailed(err);
      });
  };

  /**
   * Report a failed action without destroying the page around it.
   *
   * The customer keeps their dashboard, keeps their real data, and gets one
   * line telling them what happened and what to do. Nothing is claimed about
   * whether the change applied unless we actually know.
   */
  Portal.prototype.actionFailed = function (err) {
    var code = (err && err.code) || 'server';
    var message;

    if (code === 'in_progress') {
      message = 'That is already being processed.';
    } else if (code === 'already_applied') {
      // The server refused a duplicate. The change IS in place, so this is
      // never phrased as a failure — phrasing it as one is what would send a
      // customer round again and skip a second delivery.
      message = 'That is already done — refresh to see the latest.';
    } else if (code === 'stale_view') {
      message = 'This page is out of date — refresh, then try again.';
    } else if (code === 'timeout') {
      // The one case where the outcome is genuinely unknown. Say exactly that.
      message = 'That is taking longer than expected — refresh to check whether it went through.';
    } else if (code === 'not_enabled') {
      message = 'That is not available yet.';
    } else if (code === 'network') {
      message = 'No connection. Check your signal and try again.';
    } else {
      message = 'That did not go through. Nothing has changed — please try again.';
    }

    this.toast(message);
    this.render();
  };

  /**
   * The write applied but the refresh did not.
   *
   * Never reported as a failure: the change is real. The customer is told it
   * worked and asked to refresh, rather than being told nothing happened and
   * being tempted to do it a second time.
   */
  Portal.prototype.refreshRequired = function () {
    this.toast('Done — refresh to see the updated dates.');
    this.render();
  };

  /** Re-read what a mutation may have changed. Requires a session. */
  Portal.prototype.refreshAuthenticatedData = function () {
    var self = this;
    if (!this.hasSession()) {
      return Promise.reject(NS.PortalError('unauthenticated', 'Sign in to view your subscription.'));
    }
    return this.adapter.getLoyalty().then(function (loy) {
      self.state.loyalty = loy;
      return self.adapter.listSubscriptions();
    }).then(function (subs) {
      self.state.inactive = subs.inactive;
      return self.adapter.listDeliveries();
    }).then(function (dels) {
      self.state.deliveries = dels;
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
      // aria-disabled is what the delegated handler checks; `disabled` is what
      // stops the browser dispatching a click at all — including to a listener
      // this code did not attach, and including keyboard activation. Both, so
      // the guarantee does not depend on our own handler running first.
      if (on) {
        b.setAttribute('aria-disabled', 'true');
        if ('disabled' in b) b.disabled = true;
      } else {
        b.removeAttribute('aria-disabled');
        if ('disabled' in b) b.disabled = false;
      }
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
    var s = this.state, sub = s.data, loy = s.loyalty, cus = s.customer;
    var d = s.draft, self = this;
    var vm = {};

    if (cus) {
      // Live Phoenix data carries no display name, and the backend never
      // returns the address to the browser. Missing parts render as empty
      // rather than as the string "null".
      vm['customer.initials'] = cus.initials || '';
      vm['customer.firstName'] = cus.firstName || '';
      vm['customer.fullName'] = [cus.firstName, cus.lastName].filter(Boolean).join(' ');
      vm['customer.email'] = cus.email || '';
    }

    // One slot for the whole greeting. Splitting it into "Hi " plus a name slot
    // rendered a bare "Hi" whenever Phoenix had no first name, and a dangling
    // comma if punctuation had been added to the markup instead.
    vm['customer.greeting'] = cus && cus.firstName ? 'Hi, ' + cus.firstName : 'Hi there';

    if (sub) {
      vm['subscription.reference'] = sub.reference;
      vm['subscription.statusLabel'] = sub.status === 'active' ? 'Active' : 'Cancelled';
      vm['subscription.intervalDays'] = sub.intervalDays == null ? '' : String(sub.intervalDays);
      vm['subscription.nextOrderMedium'] = this.fmtDate(sub.nextOrderDate, 'medium');
      vm['subscription.nextOrderShort'] = this.fmtDate(sub.nextOrderDate, 'short');
      vm['subscription.startedLong'] = this.fmtDate(sub.startedOn, 'full');
      vm['subscription.deliveriesSoFar'] = sub.deliveriesSoFar == null ? '' : String(sub.deliveriesSoFar);
      vm['subscription.discountPercent'] = sub.discountRate == null ? '' : String(Math.round(sub.discountRate * 100));
      vm['subscription.daysAway'] = sub.daysUntilNextOrder + ' days away';
      vm['subscription.progressLabel'] = 'Next delivery in ' + sub.daysUntilNextOrder + ' days';
      vm['subscription.shipProgress'] = Math.max(6, 100 - Math.min(100, sub.daysUntilNextOrder * 1.6));
      // The backend returns city/province/country only, and withholds the
      // street line and postal code deliberately. Both the address and the
      // card can also be absent entirely, so every part is optional here.
      var addr = sub.address;
      if (addr) {
        vm['subscription.addressShort'] = [addr.city, addr.province].filter(Boolean).join(', ');
        vm['subscription.addressLines'] = [
          addr.name,
          addr.line1 ? addr.line1 + (addr.line2 ? ', ' + addr.line2 : '') : '',
          [addr.city, addr.province].filter(Boolean).join(', ') + (addr.zip ? ' ' + addr.zip : ''),
          addr.country
        ].filter(Boolean).map(function (x) { return self.escape(x); }).join('<br>');
      } else {
        vm['subscription.addressShort'] = '';
        vm['subscription.addressLines'] = '';
      }

      var pay = sub.payment;
      vm['subscription.paymentShort'] = pay && pay.brand
        ? pay.brand + (pay.last4 ? ' ···· ' + pay.last4 : '')
        : '';
      vm['subscription.paymentBrand'] = pay && pay.brand ? pay.brand.toUpperCase() : '';
      vm['subscription.paymentLast4'] = (pay && pay.last4) || '';
      vm['subscription.paymentExpiry'] = (pay && pay.expiry) || '';
      vm['subscription.quantitySummary'] = sub.lines.map(function (l) {
        return l.title.replace(/ (jar|pack).*$/, '') + ' ×' + l.quantity;
      }).join(', ');

      vm['pricing.total'] = this.fmtMoney(sub.pricing.total);
      vm['pricing.discount'] = this.fmtMoney(sub.pricing.discount);

      vm['sheet.skipToLong'] = this.fmtDate(NS.dates.addDays(sub.nextOrderDate, sub.intervalDays), 'long');
      var target = this.delayTargetIso();
      vm['sheet.delayToLong'] = target ? this.fmtDate(target, 'long') : 'Not chosen yet';
      // The confirmation the customer reads before committing: where the
      // delivery is now, and where it would go.
      vm['sheet.rescheduleFrom'] = this.fmtDate(sub.nextOrderDate, 'medium');
      vm['sheet.rescheduleTo'] = target ? this.fmtDate(target, 'medium') : '—';
      vm['sheet.rescheduleError'] = this.rescheduleError() || '';
    }

    if (loy) {
      vm['loyalty.points'] = String(loy.points);
      vm['loyalty.perRenewal'] = String(loy.perRenewal);
      vm['loyalty.nextRewardAt'] = String(loy.nextRewardAt);
      vm['loyalty.nextRewardName'] = loy.nextRewardName;
      vm['loyalty.toNextReward'] = String(loy.toNextReward);
      vm['loyalty.progressPercent'] = loy.progressPercent;
      vm['loyalty.disclosure'] = loy.disclosure || '';
    }

    vm['account.activeCount'] = sub && sub.status !== 'cancelled' ? '1 active' : '0 active';
    vm['account.inactiveCount'] = String(s.inactive.length);

    // Retention offers — skip or delay only. Nothing else is supported.
    var shortNext = sub ? this.fmtDate(sub.nextOrderDate, 'short') : '';
    var alts = {
      price: ['Would a longer gap help?',
        'Skipping the next delivery lowers what you spend this month without changing what arrives.',
        'Skip ' + shortNext, 'You won\'t be charged for that delivery, and the one after it stays on schedule.',
        'Skip this delivery', 'skip'],
      stock: ['Then skip the next one',
        'Nothing has to ship until you need it. Skipping keeps your price and your place in the routine.',
        'Skip ' + shortNext, 'You won\'t be charged for that delivery. The one after it stays on schedule.',
        'Skip this delivery', 'skip'],
      // Identity-free. These strings are written into [data-spp-field] slots
      // by render(), so clearPlaceholders() never sees them — naming the
      // prototype's pets here would put them in front of a real customer.
      pet: ['Give it a little longer?',
        'If you are already stocked up, skipping costs nothing and keeps everything else in place.',
        'Skip ' + shortNext, 'Your price and your place in the routine are kept.',
        'Skip this delivery', 'skip'],
      'switch': ['Take a break first?',
        'Skipping the next delivery gives you time to decide, and nothing is charged in the meantime.',
        'Skip ' + shortNext, 'Your price and your place in the routine are kept.',
        'Skip this delivery', 'skip'],
      other: ['Before you cancel',
        'Two quicker options that keep your subscriber price. Cancelling stays available below.',
        'Skip ' + shortNext, 'Push the next delivery back without any charge.',
        'Skip this delivery', 'skip']
    };
    var alt = alts[d.reason] || alts.other;
    vm['alt.headline'] = alt[0];
    vm['alt.body'] = alt[1];
    vm['alt.primaryTitle'] = alt[2];
    vm['alt.primaryBody'] = alt[3];
    vm['alt.primaryCta'] = alt[4];
    this._altAction = alt[5];

    vm['error.reference'] = s.error ? s.error.reference : '';
    if (s.success) {
      vm['success.title'] = s.success.title;
      vm['success.body'] = s.success.body;
    }

    var p = s.pending;
    vm['label.sendLink'] = p === 'sendLink' ? 'Sending link…' : 'Email me a sign-in link';
    vm['label.resend'] = p === 'resend' ? 'Sending…' : 'Resend link';
    vm['label.skip'] = p === 'skip' ? 'Skipping delivery…' : 'Skip this delivery';
    var delayTarget = sub ? this.delayTargetIso() : null;
    vm['label.delay'] = p === 'delay'
      ? 'Rescheduling…'
      : (delayTarget ? 'Move to ' + this.fmtDate(delayTarget, 'short') : 'Choose a date');
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

    var fields = this.root.querySelectorAll('[data-spp-field]');
    for (i = 0; i < fields.length; i++) {
      var key = fields[i].getAttribute('data-spp-field');
      if (key === 'toast.message') continue;
      if (Object.prototype.hasOwnProperty.call(vm, key)) fields[i].textContent = vm[key];
    }

    var htmlFields = this.root.querySelectorAll('[data-spp-field-html]');
    for (i = 0; i < htmlFields.length; i++) {
      var hk = htmlFields[i].getAttribute('data-spp-field-html');
      if (Object.prototype.hasOwnProperty.call(vm, hk)) htmlFields[i].innerHTML = vm[hk];
    }

    var ariaFields = this.root.querySelectorAll('[data-spp-field-aria]');
    for (i = 0; i < ariaFields.length; i++) {
      var ak = ariaFields[i].getAttribute('data-spp-field-aria');
      if (Object.prototype.hasOwnProperty.call(vm, ak)) ariaFields[i].setAttribute('aria-label', vm[ak]);
    }

    var widths = this.root.querySelectorAll('[data-spp-style-width]');
    for (i = 0; i < widths.length; i++) {
      var wk = widths[i].getAttribute('data-spp-style-width');
      if (Object.prototype.hasOwnProperty.call(vm, wk)) widths[i].style.width = vm[wk] + '%';
    }

    // Status is a single canonical value: active or cancelled. At most one
    // conditional block can ever be visible.
    var status = this.state.data ? this.state.data.status : 'active';
    var conds = this.root.querySelectorAll('[data-spp-when]');
    for (i = 0; i < conds.length; i++) {
      var expr = conds[i].getAttribute('data-spp-when').split(':');
      if (expr[0] === 'status') conds[i].hidden = status !== expr[1];
    }

    var badge = this.root.querySelector('[data-spp-status-badge]');
    if (badge) badge.style.background = status === 'active' ? 'var(--spp-light)' : 'var(--spp-surface-neutral)';

    this.renderLists();
    this.renderDatePicker();
  };

  /**
   * The custom-date field: shown only when the customer asked for one, and
   * bounded to exactly the window the server accepts.
   *
   * The input is never re-set while it holds focus. Writing `value` on every
   * render would fight the customer mid-edit and, in some browsers, reset the
   * caret on each keystroke.
   */
  Portal.prototype.renderDatePicker = function () {
    var wrap = this.root.querySelector('[data-spp-custom-date]');
    if (!wrap) return;

    var on = this.isCustomDate();
    wrap.hidden = !on;
    if (!on) return;

    var input = wrap.querySelector('[data-spp-date]');
    if (!input) return;

    var b = this.rescheduleBounds();
    input.min = b.min;
    input.max = b.max;
    if (document.activeElement !== input) input.value = this.state.draft.date || '';

    var err = this.rescheduleError();
    // Only complain once the customer has actually chosen something. An empty
    // field on opening is not a mistake they have made yet.
    var showErr = !!err && !!this.state.draft.date;
    input.setAttribute('aria-invalid', showErr ? 'true' : 'false');

    var msg = wrap.querySelector('[data-spp-date-error]');
    if (msg) {
      msg.textContent = showErr ? err : '';
      msg.hidden = !showErr;
    }
  };

  /* -----------------------------------------------------------------
   * Lists
   * ----------------------------------------------------------------- */

  var PENDING_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<rect x="3.2" y="5.2" width="17.6" height="13.6" rx="2.6" stroke="currentColor" stroke-width="1.6"/>' +
    '<circle cx="8.6" cy="10" r="1.6" fill="currentColor"/>' +
    '<path d="M3.6 16.4l4.6-4 3.4 3 3.2-2.6 5.4 4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  /**
   * The store's product images, keyed by Shopify product and variant id.
   *
   * Emitted by the section from Liquid, because Liquid is the only part of
   * this system that has the catalogue. Parsed once; a malformed or absent
   * block simply means every line falls back to the branded pending tile.
   */
  Portal.prototype.imageMap = function () {
    if (this._imageMap) return this._imageMap;
    this._imageMap = {};
    try {
      var el = this.root.querySelector('[data-spp-image-map]');
      if (el && el.textContent) {
        var parsed = JSON.parse(el.textContent);
        for (var key in parsed) {
          if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
          var entry = parsed[key];
          if (entry && entry.src) this._imageMap[String(key)] = entry;
        }
      }
    } catch (e) {
      // A bad map is not a reason to fail a render.
    }
    return this._imageMap;
  };

  /**
   * Resolve a line's product image, or nothing.
   *
   * Never guesses: an id that is not in the map returns null and the caller
   * renders the branded packshot-pending tile. Showing the wrong product's
   * photo would be worse than showing none.
   */
  Portal.prototype.imageForLine = function (line) {
    if (!line) return null;
    var map = this.imageMap();
    var keys = [line.variantId, line.productId, line.id];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] == null) continue;
      var hit = map[String(keys[i])];
      if (hit && hit.src) return hit;
    }
    return null;
  };

  /** Fill _image/_pending/_alt2 for one line, mock or live. */
  Portal.prototype.lineImage = function (line) {
    // Mock mode carries its own images on the line itself.
    if (line.image) return { _image: line.image, _pending: false, _alt2: line.title || '' };
    var resolved = this.imageForLine(line);
    if (resolved) {
      return { _image: resolved.src, _pending: false, _alt2: resolved.alt || line.title || '' };
    }
    return { _image: '', _pending: true, _alt2: line.title || '' };
  };

  Portal.prototype.listData = function (name) {
    var s = this.state, sub = s.data, d = s.draft, self = this;

    switch (name) {
      // Pets are a mock-only concept: Phoenix exposes no pet record, so the
      // live adapter returns a customer without them.
      case 'pets':
        return ((s.customer && s.customer.pets) || []).map(function (p, i) {
          return { name: p.name, initial: p.initial, _alt: i > 0 };
        });

      case 'petsFull':
        return ((s.customer && s.customer.pets) || []).map(function (p, i) {
          return { initial: p.initial, nameBreed: p.name + ' · ' + p.breed, _alt: i > 0 };
        });

      case 'lineThumbs':
      case 'lineThumbs2':
        return (sub ? sub.lines : []).map(function (l) {
          return self.lineImage(l);
        });

      case 'lines':
        return (sub ? sub.lines : []).map(function (l) {
          var img = self.lineImage(l);
          return {
            title: l.title, subtitle: l.subtitle, quantity: String(l.quantity),
            unitPrice: self.fmtMoney(l.unitPrice),
            _image: img._image, _pending: img._pending, _alt2: img._alt2
          };
        });

      case 'lineSummary':
        return (sub ? sub.lines : []).map(function (l) {
          return { title: l.title, quantity: String(l.quantity), linePrice: self.fmtMoney(l.linePrice) };
        });

      case 'deliveriesPreview': {
        if (!s.deliveries) return [];
        var out = [];
        var up = s.deliveries.upcoming;
        // There is no upcoming delivery for a cancelled subscription, and no
        // date to format if Phoenix has not scheduled one.
        if (up && up.date) out.push({
          mon: NS.dates.parseISO(up.date).toLocaleDateString('en', { month: 'short' }).toUpperCase(),
          day: String(NS.dates.parseISO(up.date).getDate()),
          title: up.title, meta: up.items, status: up.status
        });
        (s.deliveries.past || []).slice(0, 2).forEach(function (o) {
          if (!o.date) return;
          out.push({
            mon: NS.dates.parseISO(o.date).toLocaleDateString('en', { month: 'short' }).toUpperCase(),
            day: String(NS.dates.parseISO(o.date).getDate()),
            title: 'Delivered',
            meta: [o.orderId ? 'Order #' + o.orderId : '', self.fmtMoney(o.amount)]
              .filter(Boolean).join(' · '),
            status: 'Complete'
          });
        });
        return out;
      }

      case 'pastOrders':
        return ((s.deliveries && s.deliveries.past) || []).map(function (o) {
          return {
            dateLong: self.fmtDate(o.date, 'full'), items: o.items,
            amount: self.fmtMoney(o.amount), status: o.status,
            _image: self.cfg.images.freshwipes, _pending: false, _alt2: ''
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
          var label = r.pendingRequest ? 'Requested'
            : r.affordable ? 'Redeem' : (r.pointsToGo + ' points to go');
          return {
            name: r.name, cost: String(r.cost), btnLabel: label,
            _image: r.image, _pending: r.imagePending, _alt2: r.name,
            _rewardId: r.id,
            _affordable: r.affordable && !r.pendingRequest
          };
        });

      case 'reasons':
        return [
          ['price', 'Too expensive'],
          ['stock', 'I still have plenty left'],
          ['pet', 'My dog no longer needs it'],
          ['switch', 'Switching to another product'],
          ['other', 'Something else']
        ].map(function (r) { return { label: r[1], _value: r[0], _checked: d.reason === r[0] }; });

      case 'delayOptions': {
        var tiles = [7, 15, 30].map(function (n) {
          return { label: n + ' days', _value: n, _checked: d.delay === n };
        });
        // A fourth tile, styled exactly like the presets, so choosing a
        // specific date is as ordinary as choosing "7 days".
        tiles.push({ label: 'Choose another date', _value: 'custom', _checked: d.delay === 'custom' });
        return tiles;
      }

      case 'restartDates':
        return [['As soon as possible', 0], ['In two weeks', 14], ['In a month', 30]]
          .map(function (r, i) { return { label: r[0], _value: r[1], _checked: d.restart === i, _index: i }; });

      case 'inactiveSubs':
        return s.inactive.map(function (x) {
          // No `reference`: nothing renders it any more, and supplying an
          // internal id to a template is how it finds its way back on screen.
          return {
            statusLabel: x.status === 'cancelled' ? 'Cancelled' : 'Completed',
            name: x.name, meta: x.meta,
            _image: x.image, _pending: false, _alt2: x.name
          };
        });

      case 'cancelFacts': {
        if (!sub) return [];
        var card = sub.payment;
        return [
          'Your ' + self.fmtDate(sub.nextOrderDate, 'short') + ' delivery will not ship.',
          card && card.brand
            ? 'No further charges will be made to ' + card.brand +
              (card.last4 ? ' ···· ' + card.last4 : '') + '.'
            : 'No further charges will be made.',
          'Your ' + (s.loyalty ? s.loyalty.points : 0) + ' VetPoints stay on the account for 12 months.',
          'You can reactivate with the same products and price at any time.',
          // Last, and phrased as care rather than pressure: by this screen the
          // decision is made, and a sales pitch here would read as one.
          'RoutineCare keeps daily care consistent, helping prevent buildup before it becomes a recurring problem.'
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

      var kids = Array.prototype.slice.call(host.children);
      for (var k = 0; k < kids.length; k++) if (kids[k] !== tpl) host.removeChild(kids[k]);

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

    var fields = node.querySelectorAll('[data-spp-field]');
    for (i = 0; i < fields.length; i++) {
      var key = fields[i].getAttribute('data-spp-field');
      if (Object.prototype.hasOwnProperty.call(item, key)) fields[i].textContent = item[key];
    }
    if (node.hasAttribute && node.hasAttribute('data-spp-field')) {
      var rk = node.getAttribute('data-spp-field');
      if (Object.prototype.hasOwnProperty.call(item, rk)) node.textContent = item[rk];
    }

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
          // Named, not decorative: in the thumb strip the photo is the only
          // thing identifying the product.
          img.alt = item._alt2 || '';
          img.loading = 'lazy';
          img.decoding = 'async';
          // Reserve the box so the row does not jump when the photo arrives.
          // The CSS sizes the tile; these stop the intrinsic ratio from
          // being unknown until load.
          img.setAttribute('width', '64');
          img.setAttribute('height', '64');
        } else {
          img.remove();
        }
      }
    }

    if (typeof item._checked === 'boolean') {
      var pick = node.matches && node.matches('[data-spp-pick]') ? node : node.querySelector('[data-spp-pick]');
      if (pick) {
        pick.setAttribute('aria-checked', item._checked ? 'true' : 'false');
        pick.classList.toggle('is-selected', item._checked);
      }
    }

    var carriers = node.querySelectorAll('[data-spp-pick], [data-spp-act]');
    var all = Array.prototype.slice.call(carriers);
    if (node.matches && (node.matches('[data-spp-pick]') || node.matches('[data-spp-act]'))) all.push(node);
    for (i = 0; i < all.length; i++) {
      if (item._value !== undefined) all[i].dataset.sppValue = item._value;
      if (item._rewardId) all[i].dataset.sppReward = item._rewardId;
      if (item._index !== undefined) all[i].dataset.sppIndex = item._index;
      all[i].dataset.sppListIndex = index;
    }

    if (item._alt) {
      var dot = node.querySelector('.spp__chip-dot');
      if (dot) dot.classList.add('spp__chip-dot--alt');
    }

    if (listName === 'rewards') {
      var btn = node.querySelector('[data-spp-act="requestRedemption"]');
      if (btn) {
        if (item._affordable) {
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
  };

  /* =================================================================
   * Events
   * ================================================================= */

  Portal.prototype.bind = function () {
    var self = this;

    this.root.addEventListener('click', function (e) {
      var el;
      if ((el = e.target.closest('[data-spp-go]'))) {
        e.preventDefault(); self.show(el.getAttribute('data-spp-go')); return;
      }
      if ((el = e.target.closest('[data-spp-sheet]'))) {
        e.preventDefault(); self.openSheet(el.getAttribute('data-spp-sheet')); return;
      }
      if ((el = e.target.closest('[data-spp-pick]'))) {
        e.preventDefault(); self.pick(el); return;
      }
      if ((el = e.target.closest('[data-spp-act]'))) {
        e.preventDefault();
        if (el.getAttribute('aria-disabled') === 'true') return;
        self.act(el.getAttribute('data-spp-act'), el);
        return;
      }
      if ((el = e.target.closest('[data-spp-dev-toggle]'))) {
        var panel = el.closest('[data-spp-dev]');
        panel.setAttribute('data-collapsed', panel.getAttribute('data-collapsed') === 'true' ? 'false' : 'true');
        return;
      }
      if ((el = e.target.closest('[data-spp-dev-status]'))) {
        self.adapter.setStatus(el.getAttribute('data-spp-dev-status')).then(function (sub) {
          self.state.data = sub; self.show('dashboard');
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
      if (e.target.hasAttribute && e.target.hasAttribute('data-spp-overlay')) self.closeSheet();
    });

    this.root.addEventListener('change', function (e) {
      var date = e.target.closest('[data-spp-date]');
      if (date) {
        self.state.draft.date = date.value || null;
        self.render();
        return;
      }
      var sel = e.target.closest('[data-spp-dev-currency]');
      if (!sel || !self.adapter.setCurrency) return;
      self.adapter.setCurrency(sel.value).then(function () { return self.load(); });
    });

    // `change` alone fires late on some mobile pickers, leaving the summary
    // and the button label stale after a date has visibly been chosen.
    this.root.addEventListener('input', function (e) {
      var date = e.target.closest('[data-spp-date]');
      if (!date) return;
      self.state.draft.date = date.value || null;
      self.render();
    });

    this.root.addEventListener('submit', function (e) {
      var form = e.target.closest('form[data-spp-form]');
      if (!form) return;
      e.preventDefault();
      if (form.getAttribute('data-spp-form') === 'login') self.act('sendLink', form);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self.state.sheet && !self.state.pending) { self.closeSheet(); return; }
      if (e.key === 'Tab' && self.state.sheet) self.trapFocus(e);
    });
  };

  Portal.prototype.trapFocus = function (e) {
    var host = this.root.querySelector('[data-spp-sheet-host]');
    if (!host) return;
    var f = this.focusablesIn(host);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  Portal.prototype.pick = function (el) {
    var kind = el.getAttribute('data-spp-pick');
    var d = this.state.draft;
    var value = el.dataset.sppValue;

    if (kind === 'delay') d.delay = value === 'custom' ? 'custom' : parseInt(value, 10);
    else if (kind === 'reason') d.reason = value;
    else if (kind === 'restart') d.restart = parseInt(el.dataset.sppIndex, 10);
    this.render();
  };

  /* -----------------------------------------------------------------
   * Actions — one per supported Phoenix operation, plus auth and loyalty
   * ----------------------------------------------------------------- */

  /**
   * Actions that change billing, and may therefore run at most once per
   * opened confirmation. Navigation and sheet-opening are not among them.
   */
  var CONFIRMED_ACTIONS = { skip: 1, delay: 1, reschedule: 1, cancel: 1, reactivate: 1 };

  Portal.prototype.act = function (name, el) {
    var self = this, s = this.state, d = s.draft, sub = s.data;
    var id = sub ? sub.id : null;

    // ONE CONFIRMATION, AT MOST ONE MUTATION.
    //
    // Checked here rather than in the click handler so it holds however act()
    // was reached — a click, a keyboard activation, a form submit, or a second
    // listener nobody meant to attach.
    if (CONFIRMED_ACTIONS[name]) {
      // Already in flight. The spinner on the button is the answer; saying
      // anything else here would talk over it.
      if (s.pending) return;

      if (s.confirmSpent) {
        // NEVER SILENT.
        //
        // A refusal the customer cannot see is indistinguishable from a broken
        // button, and a customer who thinks a button is broken presses it
        // again. That is precisely what happened: the guard refused every
        // press of "Yes, cancel my subscription" without a word.
        this.toast('That has already been submitted — refresh to see the latest.');
        return;
      }
      s.confirmSpent = true;
    }

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
        // refresh:false — there is no session yet. See run().
        this.run('sendLink', function () { return self.adapter.requestMagicLink(value); }, {
          closeSheet: false,
          refresh: false,
          then: function () {
            // Neutral by design: the same screen shows whether or not an
            // account exists, so the portal cannot be used to enumerate.
            self.state.customer = self.state.customer || {};
            self.state.customer.email = value;
            self.show('sent');
          }
        });
        return;
      }

      case 'openLink':
        this.show('loading');
        this.load().then(function () { self.show('dashboard'); }).catch(function (e) { self.fail(e); });
        return;

      case 'resend':
        // Mock-only control, and refresh:false for the same reason as sendLink.
        this.run('resend', function () {
          return self.adapter.requestMagicLink(s.customer ? s.customer.email : '');
        }, {
          closeSheet: false,
          refresh: false,
          then: function () { self.show('sent'); },
          toast: 'New sign-in link sent'
        });
        return;

      case 'retry':
        // Identical handling to boot: fail() decides sign-in vs error screen,
        // so a dead session can never render as a subscription-read failure.
        this.state.error = null;
        if (!this.hasSession()) { this.fail(NS.PortalError('unauthenticated', '')); return; }
        this.show('loading');
        this.load().then(function () { self.show('dashboard'); }).catch(function (e) { self.fail(e); });
        return;

      /* --- POST /update-next-billing-date --- */
      case 'skip': {
        var before = sub.nextOrderDate;
        this.run('skip', function (attemptKey) {
          return self.adapter.skipNextDelivery(id, {
            idempotencyKey: attemptKey,
            // The date on screen when the customer confirmed. The server
            // refuses the request if Phoenix no longer holds it, so a stale
            // duplicate cannot skip a second cycle.
            expectedNextBillingDate: before
          });
        }, {
          attempt: 'skip',
          // Stay on the dashboard and confirm there. The refreshed next
          // delivery date is already on screen behind the toast, which is a
          // better confirmation than a separate screen describing it.
          then: function (st) {
            self.show('dashboard');
          },
          toast: function (st) {
            var next = st.data && st.data.nextOrderDate;
            return next
              ? 'Delivery skipped — next one ' + self.fmtDate(next, 'long')
              : 'Delivery skipped';
          }
        });
        return;
      }

      case 'delay': {
        var custom = this.isCustomDate();

        // A date the server would refuse never leaves the browser. The sheet
        // stays open with the reason shown, so the customer can correct it
        // rather than being told the operation failed.
        if (custom && this.rescheduleError()) {
          s.confirmSpent = false;
          this.render();
          return;
        }

        var chosen = custom ? d.date : null;
        this.run('delay', function (attemptKey) {
          var opts = {
            idempotencyKey: attemptKey,
            // The date on screen when the customer confirmed. Without it the
            // server cannot tell a duplicate from a second, genuine change.
            expectedNextBillingDate: sub.nextOrderDate
          };
          return custom
            ? self.adapter.rescheduleNextDelivery(id, chosen, opts)
            : self.adapter.delayNextDelivery(id, d.delay, opts);
        }, {
          attempt: custom ? 'reschedule' : 'delay',
          then: function () { self.show('dashboard'); },
          toast: function (st) { return 'Delivery moved to ' + self.fmtDate(st.data.nextOrderDate, 'short'); }
        });
        return;
      }

      /* --- POST /cancel-subscription --- */
      case 'cancel':
        this.run('cancel', function (attemptKey) {
          return self.adapter.cancel(id, d.reason, null, { idempotencyKey: attemptKey });
        }, {
          attempt: 'cancel',
          then: function () { self.show('cancel-done'); }
        });
        return;

      /* --- POST /activate-subscription --- */
      case 'reactivate': {
        var offsets = [0, 14, 30];
        this.run('reactivate', function (attemptKey) {
          return self.adapter.reactivate(id, offsets[d.restart] || 0, { idempotencyKey: attemptKey });
        }, {
          attempt: 'reactivate',
          then: function () { self.show('dashboard'); },
          toast: 'Subscription reactivated'
        });
        return;
      }

      /* --- loyalty: request only, never a fulfilment claim --- */
      case 'requestRedemption': {
        var rewardId = el && el.dataset.sppReward;
        if (!rewardId || el.getAttribute('aria-disabled') === 'true') return;
        this.run('requestRedemption', function () { return self.adapter.requestRedemption(rewardId); }, {
          closeSheet: false,
          then: function (st, result) {
            return self.adapter.listRewards().then(function (r) {
              self.state.rewards = r;
              self.render();
              self.toast((result && result.message) ||
                'Your reward request has been received. It will be added to an upcoming delivery.');
            });
          }
        });
        return;
      }

      case 'altPrimary':
        // Only skip or delay can ever be offered here.
        if (this._altAction === 'delay') this.openSheet('delay');
        else this.openSheet('skip');
        return;

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

  /**
   * Last-resort reveal. If the portal cannot boot at all, the customer must
   * still see something they can act on — never a blank page. This walks the
   * DOM directly rather than going through Portal, because the reason we are
   * here is that Portal could not be constructed.
   */
  function revealFallback(scope, detail) {
    var host = scope || document.querySelector('.spp') || document.body;
    if (!host || host.__sppFallbackShown) return;
    host.__sppFallbackShown = true;

    var error = host.querySelector ? host.querySelector('[data-spp-screen="error"]') : null;
    if (error) {
      // Hide every other screen, then reveal the real error screen so the
      // approved design and its "Try again" affordance are what the customer sees.
      var all = host.querySelectorAll('[data-spp-screen]');
      for (var i = 0; i < all.length; i++) all[i].hidden = true;
      error.hidden = false;
      var ref = error.querySelector('[data-spp-field="error.reference"]');
      if (ref && !ref.textContent) ref.textContent = 'SUB-BOOT';
      return;
    }

    // The markup itself is missing or damaged — inject a minimal notice
    // rather than leaving the page empty.
    var note = document.createElement('div');
    note.setAttribute('role', 'alert');
    note.style.cssText = 'max-width:520px;margin:40px auto;padding:20px;border-radius:14px;' +
      'background:#EEF2F6;border:1px solid rgba(13,35,64,.14);font:500 15px/1.5 system-ui,sans-serif;color:#33445C;';
    note.innerHTML = '<strong style="display:block;color:#0F172A;margin-bottom:6px;">' +
      'We couldn’t load your subscription</strong>' +
      'Nothing has changed on your account. Please refresh, or contact support if it keeps happening.';
    (host.appendChild ? host : document.body).appendChild(note);
    if (window.console && console.error) console.error('[spp] bootstrap failed:', detail || '');
  }

  function init() {
    var roots = document.querySelectorAll('[data-spp-portal]');

    // No root at all. Historically this happened when a Liquid whitespace
    // hyphen welded `data-spp-portal` onto the next attribute, which left the
    // page silently blank. Fail visibly instead.
    if (!roots.length) {
      revealFallback(null, 'no [data-spp-portal] root found');
      return;
    }

    for (var i = 0; i < roots.length; i++) {
      if (roots[i].__sppBooted) continue;
      roots[i].__sppBooted = true;
      try {
        new Portal(roots[i]);
      } catch (e) {
        // Portal itself could not be constructed or could not show a screen.
        revealFallback(roots[i], e && e.message);
      }
    }

    // Belt and braces: if nothing is visible shortly after boot, reveal the
    // error screen rather than leaving the customer looking at nothing.
    setTimeout(function () {
      for (var j = 0; j < roots.length; j++) {
        var visible = roots[j].querySelector('[data-spp-screen]:not([hidden])');
        if (!visible) revealFallback(roots[j], 'no screen visible after init');
      }
    }, 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  document.addEventListener('shopify:section:load', init);
})(window, document);
