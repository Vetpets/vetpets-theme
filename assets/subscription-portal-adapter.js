/*
 * VetPets Subscription Portal — data adapter
 * ==================================================================
 * The ONLY place the portal talks to a data source. The UI layer never
 * fetches, never names a vendor, and never formats currency itself.
 *
 * SCOPE — matches the documented Phoenix Partner API and nothing more
 * ------------------------------------------------------------------
 * Reads          Phoenix endpoint
 *   customer     GET  /customers?Email=            (resolved server-side)
 *   subscription GET  /order-details?CustomerId=
 *   deliveries   GET  /order-details, /transaction-history
 *   products     GET  /products?StoreId=&Subscription=true
 *   cadence      GET  /billing-types
 *
 * Mutations      Phoenix endpoint
 *   skip         POST /update-next-billing-date
 *   delay        POST /update-next-billing-date
 *   reschedule   POST /update-next-billing-date
 *   cancel       POST /cancel-subscription
 *   reactivate   POST /activate-subscription
 *
 * Deliberately ABSENT — Phoenix documents no portal-scope operation, so
 * the portal must not offer them: change quantity, swap product, add
 * one-time item, update card, update address, change frequency,
 * pause/resume. /change-subscription-product, /add-order and /refund are
 * documented but explicitly out of scope for this phase.
 *
 * VetPoints is NOT a Phoenix concept. It is our own auditable ledger,
 * owned by our backend and keyed on Phoenix order IDs. See the loyalty
 * section below.
 *
 * SECURITY BOUNDARY
 * ------------------------------------------------------------------
 * No credential, API token, partnerId, partnerToken or vendor hostname
 * belongs in this file, in Liquid, in theme settings or in any committed
 * asset. The live adapter calls a first-party, same-origin path only.
 * That server holds the Phoenix credentials, resolves CustomerId from the
 * verified session, generates the request-id, and enforces idempotency.
 *
 * The browser NEVER supplies an authoritative Phoenix CustomerId. Every
 * method below takes a subscription reference that is opaque to the
 * client; the server maps session -> CustomerId itself and ignores any
 * identifier the browser sends.
 */
(function (window) {
  'use strict';

  var VetPetsPortal = (window.VetPetsPortal = window.VetPetsPortal || {});

  /* ---------------------------------------------------------------
   * Errors
   * --------------------------------------------------------------- */

  function PortalError(code, message, reference) {
    var err = new Error(message || code);
    err.name = 'PortalError';
    err.code = code;                   // 'expired_link' | 'network' | 'server' | ...
    err.reference = reference || null; // support-facing reference for the error state
    return err;
  }
  VetPetsPortal.PortalError = PortalError;

  /* ---------------------------------------------------------------
   * Money — locale aware, currency always carried explicitly
   *
   * In production the currency code comes from Phoenix order details.
   * It is never inferred, never defaulted to USD by the model, the
   * formatter or the UI.
   * --------------------------------------------------------------- */

  var LOCALE_BY_CURRENCY = { USD: 'en-US', GBP: 'en-GB', EUR: 'de-DE', SEK: 'sv-SE' };
  VetPetsPortal.SUPPORTED_CURRENCIES = ['USD', 'GBP', 'EUR', 'SEK'];

  function money(amount, currencyCode) {
    return { amount: Number(amount), currencyCode: currencyCode };
  }
  VetPetsPortal.money = money;

  function formatMoney(value, localeHint) {
    if (!value || typeof value.amount !== 'number' || isNaN(value.amount)) return '';
    var currency = value.currencyCode;
    if (!currency) return '';           // no currency => render nothing, never guess
    var locale = localeHint || LOCALE_BY_CURRENCY[currency] || undefined;
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency', currency: currency,
        minimumFractionDigits: 2, maximumFractionDigits: 2
      }).format(value.amount);
    } catch (e) {
      return currency + ' ' + value.amount.toFixed(2);
    }
  }
  VetPetsPortal.formatMoney = formatMoney;

  function addMoney(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.currencyCode !== b.currencyCode) {
      throw PortalError('currency_mismatch', 'Cannot add ' + a.currencyCode + ' to ' + b.currencyCode);
    }
    return money(a.amount + b.amount, a.currencyCode);
  }
  VetPetsPortal.addMoney = addMoney;

  function multiplyMoney(a, n) { return money(a.amount * n, a.currencyCode); }
  VetPetsPortal.multiplyMoney = multiplyMoney;

  /* ---------------------------------------------------------------
   * Dates — ISO in the model, formatted only at the edge.
   * Phoenix uses YYYY-MM-DD for NextBillingDate.
   * --------------------------------------------------------------- */

  function parseISO(iso) { var p = String(iso).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function toISO(date) {
    var m = String(date.getMonth() + 1), d = String(date.getDate());
    return date.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (d.length < 2 ? '0' + d : d);
  }
  function addDays(iso, n) { var dt = parseISO(iso); dt.setDate(dt.getDate() + n); return toISO(dt); }
  function addMonths(iso, n) { var dt = parseISO(iso); dt.setMonth(dt.getMonth() + n); return toISO(dt); }
  function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }

  VetPetsPortal.dates = {
    parseISO: parseISO, toISO: toISO, addDays: addDays, addMonths: addMonths, daysBetween: daysBetween
  };

  /* ===============================================================
   * The adapter contract
   * ===============================================================
   * Both the mock and the live adapter implement exactly this surface.
   * Anything not listed here is not a portal capability.
   * --------------------------------------------------------------- */
  VetPetsPortal.CONTRACT = {
    reads: ['getCustomer', 'getSubscription', 'listSubscriptions', 'listDeliveries',
            'getLoyalty', 'listRewards'],
    retention: ['recordCancelReason', 'acceptRetentionOffer'],
    mutations: ['skipNextDelivery', 'delayNextDelivery', 'rescheduleNextDelivery',
                'cancel', 'reactivate', 'requestRedemption'],
    auth: ['requestMagicLink', 'verifyMagicLink', 'signOut']
  };

  /* ---------------------------------------------------------------
   * Mock adapter — visual QA only
   * --------------------------------------------------------------- */

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function createMockAdapter(config) {
    config = config || {};

    // Hard stop: mock data must never reach a production portal. In
    // particular a fabricated VetPoints balance must never be shown to a
    // real customer.
    if (config.mode === 'live') {
      throw PortalError(
        'mock_in_production',
        'The mock adapter cannot run in live mode. VetPoints and subscription ' +
        'data must come from the backend ledger and Phoenix.'
      );
    }

    var TODAY = config.today || '2026-08-21';
    var LATENCY = typeof config.latency === 'number' ? config.latency : 900;
    var IMAGES = config.images || {};

    var pointsPerRenewal = config.pointsPerRenewal || 100;
    var nextRewardAt = config.nextRewardAt || 800;
    var nextRewardName = config.nextRewardName || 'a free plush toy';

    var currency = config.currencyCode || 'USD';

    // Prototype catalogue prices per currency, so switching market never
    // reinterprets one currency's number as another's.
    var CATALOGUE = {
      freshwipes: { USD: 24.90, GBP: 19.90, EUR: 23.90, SEK: 269.00 },
      eyewipes:   { USD: 19.90, GBP: 15.90, EUR: 18.90, SEK: 215.00 },
      glovewipes: { USD: 18.90, GBP: 14.90, EUR: 17.90, SEK: 205.00 }
    };

    function priceOf(key) {
      var amount = CATALOGUE[key][currency];
      if (typeof amount !== 'number') throw PortalError('missing_price', 'No ' + currency + ' price for ' + key);
      return money(amount, currency);
    }

    var state = {
      customer: {
        id: 'cus_mock_1',
        firstName: 'Margaret', lastName: 'Ellis',
        email: config.email || 'margaret.ellis@gmail.com',
        initials: 'ME',
        pets: [
          { name: 'Bella', breed: 'French Bulldog', initial: 'B' },
          { name: 'Max', breed: 'Labrador', initial: 'M' }
        ]
      },
      session: null,
      subscription: {
        id: 'sub_48210',
        reference: '#VP-48210',
        status: 'active',              // active | cancelled  (no paused: Phoenix has no pause)
        name: 'Daily routine subscription',
        startedOn: '2025-03-12',
        deliveriesSoFar: 9,
        intervalDays: 60,
        nextOrderDate: '2026-09-08',
        cancelledOn: null,
        discountRate: 0.10,
        shippingFree: true,
        lines: [
          { id: 'line_fresh', productKey: 'freshwipes', title: 'FreshWipes jar',
            subtitle: "for Bella & Max", quantity: 2, image: IMAGES.freshwipes || '', imagePending: false },
          { id: 'line_eye', productKey: 'eyewipes', title: 'EyeWipes jar',
            subtitle: "Bella's tear lines", quantity: 1, image: IMAGES.eyewipes || '', imagePending: false }
        ],
        address: {
          name: 'Margaret Ellis', line1: '214 Wren Street', line2: 'Apt 3B',
          city: 'Portland', province: 'OR', zip: '97209', country: 'United States'
        },
        payment: { brand: 'Visa', last4: '4242', expiry: '04/28' }
      },
      inactiveSubscriptions: [
        { id: 'sub_39104', reference: '#VP-39104', status: 'cancelled', name: 'GloveWipes pack',
          meta: 'Was every 30 days · cancelled 4 June 2026', image: IMAGES.glovewipes || '' },
        { id: 'sub_28873', reference: '#VP-28873', status: 'completed', name: 'FreshWipes starter routine',
          meta: '3 of 3 deliveries sent · ended 9 Jan 2026', image: IMAGES.freshwipes || '' }
      ],
      points: typeof config.points === 'number' ? config.points : 640,
      pointsHistory: [
        { label: 'Delivery renewed', date: '2026-07-10', delta: pointsPerRenewal, sourceOrderId: 'PHX-10442' },
        { label: 'Delivery renewed', date: '2026-05-11', delta: pointsPerRenewal, sourceOrderId: 'PHX-10218' },
        { label: 'Reward requested: free plush toy', date: '2026-04-02', delta: -300, sourceOrderId: null },
        { label: 'Delivery renewed', date: '2026-03-12', delta: pointsPerRenewal, sourceOrderId: 'PHX-10090' },
        { label: 'Referred a friend', date: '2026-02-18', delta: 140, sourceOrderId: null }
      ],
      orders: [
        { id: '10442', date: '2026-07-10', items: 'FreshWipes ×2, EyeWipes ×1', status: 'Delivered' },
        { id: '10218', date: '2026-05-11', items: 'FreshWipes ×2, EyeWipes ×1', status: 'Delivered' },
        { id: '10090', date: '2026-03-12', items: 'FreshWipes ×2', status: 'Delivered' },
        { id: '09934', date: '2026-01-11', items: 'FreshWipes ×2, GloveWipes ×1', status: 'Delivered' }
      ],
      redemptions: []
    };

    var failNext = null;
    function maybeFail() {
      if (!failNext) return null;
      var f = failNext; failNext = null;
      return PortalError(f.code, f.message, f.reference);
    }
    function respond(producer) {
      return delay(LATENCY).then(function () {
        var err = maybeFail();
        if (err) throw err;
        return producer();
      });
    }

    function lineTotal(l) { return multiplyMoney(priceOf(l.productKey), l.quantity); }

    function pricing(sub) {
      var subtotal = money(0, currency);
      sub.lines.forEach(function (l) { subtotal = addMoney(subtotal, lineTotal(l)); });
      var discount = money(subtotal.amount * sub.discountRate, currency);
      return {
        subtotal: subtotal, discount: discount, shipping: money(0, currency),
        total: money(subtotal.amount - discount.amount, currency)
      };
    }

    function projectSubscription() {
      var s = state.subscription, p = pricing(s);
      return {
        id: s.id, reference: s.reference, status: s.status, name: s.name,
        startedOn: s.startedOn, deliveriesSoFar: s.deliveriesSoFar,
        intervalDays: s.intervalDays, nextOrderDate: s.nextOrderDate,
        cancelledOn: s.cancelledOn,
        daysUntilNextOrder: Math.max(0, daysBetween(TODAY, s.nextOrderDate)),
        currencyCode: currency,
        lines: s.lines.map(function (l) {
          return {
            id: l.id, title: l.title, subtitle: l.subtitle, quantity: l.quantity,
            image: l.image, imagePending: l.imagePending,
            unitPrice: priceOf(l.productKey), linePrice: lineTotal(l)
          };
        }),
        pricing: p,
        address: clone(s.address),
        payment: clone(s.payment),
        shippingFree: s.shippingFree, discountRate: s.discountRate
      };
    }

    function projectLoyalty() {
      return {
        source: 'mock',
        points: state.points,
        perRenewal: pointsPerRenewal,
        nextRewardAt: nextRewardAt,
        nextRewardName: nextRewardName,
        toNextReward: Math.max(0, nextRewardAt - state.points),
        progressPercent: Math.min(100, Math.round((state.points / nextRewardAt) * 100)),
        placeholderEconomics: true,
        disclosure: 'Placeholder points logic — thresholds and rewards are configurable.',
        history: clone(state.pointsHistory)
      };
    }

    return {
      kind: 'mock',
      isMock: true,
      mode: 'mock',

      /* --- market / currency (mock QA only) --- */
      getCurrency: function () { return currency; },
      setCurrency: function (code) {
        if (VetPetsPortal.SUPPORTED_CURRENCIES.indexOf(code) === -1) {
          throw PortalError('unsupported_currency', code + ' is not supported');
        }
        currency = code;
        return Promise.resolve(code);
      },
      getSupportedCurrencies: function () { return VetPetsPortal.SUPPORTED_CURRENCIES.slice(); },

      /* --- QA hooks (mock only) --- */
      failNextCall: function (code, message, reference) { failNext = { code: code, message: message, reference: reference }; },
      setStatus: function (status) {
        if (status !== 'active' && status !== 'cancelled') {
          throw PortalError('unsupported_status', status + ' is not a portal status');
        }
        state.subscription.status = status;
        state.subscription.cancelledOn = status === 'cancelled' ? TODAY : null;
        return Promise.resolve(projectSubscription());
      },
      getToday: function () { return TODAY; },

      /* --- auth --- */
      requestMagicLink: function (email) {
        return respond(function () {
          state.customer.email = email || state.customer.email;
          // Neutral by design: never reveals whether the address exists.
          return { ok: true, expiresInMinutes: 15 };
        });
      },
      verifyMagicLink: function (token) {
        return respond(function () {
          if (token === 'expired') throw PortalError('expired_link', 'This link has expired');
          state.session = { token: 'mock-session' };
          return { ok: true };
        });
      },
      signOut: function () { state.session = null; return Promise.resolve({ ok: true }); },

      /* --- reads --- */
      getCustomer: function () { return respond(function () { return clone(state.customer); }); },
      listSubscriptions: function () {
        return respond(function () {
          return { active: [projectSubscription()], inactive: clone(state.inactiveSubscriptions) };
        });
      },
      getSubscription: function () { return respond(function () { return projectSubscription(); }); },
      listDeliveries: function () {
        return respond(function () {
          var s = state.subscription, p = pricing(s);
          return {
            upcoming: {
              date: s.nextOrderDate, title: 'Next delivery',
              items: s.lines.map(function (l) { return l.title.replace(/ (jar|pack)$/, '') + ' ×' + l.quantity; }).join(', '),
              total: p.total,
              status: s.status === 'active' ? 'Scheduled' : 'Cancelled'
            },
            past: state.orders.map(function (o) {
              return { orderId: o.id, date: o.date, items: o.items, amount: money(p.total.amount, currency), status: o.status };
            })
          };
        });
      },

      /* --- loyalty (our ledger, not Phoenix) --- */
      getLoyalty: function () { return respond(function () { return projectLoyalty(); }); },
      listRewards: function () {
        return respond(function () {
          return [
            { id: 'rw_glove', name: 'GloveWipes pack', cost: 300, image: IMAGES.glovewipes || '', imagePending: false },
            { id: 'rw_plush', name: 'Free plush toy', cost: nextRewardAt, image: IMAGES.reward || '', imagePending: !IMAGES.reward },
            { id: 'rw_credit', name: 'Credit on your next delivery', cost: 600, image: IMAGES.freshwipes || '', imagePending: false },
            { id: 'rw_eye', name: 'EyeWipes jar', cost: 1200, image: IMAGES.eyewipes || '', imagePending: false }
          ].map(function (r) {
            var pending = state.redemptions.some(function (x) { return x.rewardId === r.id && x.status === 'pending_manual'; });
            r.affordable = state.points >= r.cost;
            r.pointsToGo = Math.max(0, r.cost - state.points);
            r.pendingRequest = pending;
            return r;
          });
        });
      },

      /**
       * Request a reward. This RESERVES points and creates a redemption in
       * `pending_manual` — it does not ship anything. Fulfilment is manual
       * and tracked in the internal Redemption Queue.
       */
      requestRedemption: function (rewardId) {
        return respond(function () {
          var costs = { rw_glove: 300, rw_plush: nextRewardAt, rw_credit: 600, rw_eye: 1200 };
          var cost = costs[rewardId];
          if (typeof cost !== 'number') throw PortalError('unknown_reward', 'Unknown reward');
          if (state.points < cost) throw PortalError('insufficient_points', 'Not enough points');
          state.points -= cost;                       // reserved, not spent
          state.redemptions.push({ rewardId: rewardId, points: cost, status: 'pending_manual' });
          state.pointsHistory.unshift({
            label: 'Reward requested', date: TODAY, delta: -cost, sourceOrderId: null
          });
          return {
            status: 'pending_manual',
            message: 'Your reward request has been received. It will be added to an upcoming delivery.',
            loyalty: projectLoyalty()
          };
        });
      },

      /* --- mutations: all four map to documented Phoenix endpoints ---
       * Each accepts an idempotencyKey. The live adapter forwards it, and
       * the server reuses the same request-id when retrying.
       * ------------------------------------------------------------- */

      // POST /update-next-billing-date — push out by one full cycle
      recordCancelReason: function (reasonCode, note) {
        return respond(function () {
          state.lastReason = { reason: reasonCode, note: note || null };
          return { status: 'ok', recorded: true, id: 'mock-reason' };
        });
      },

      recordCancelOutcome: function (outcome) {
        return respond(function () {
          state.lastOutcome = outcome;
          return { status: 'ok', recorded: true };
        });
      },

      acceptRetentionOffer: function () {
        return respond(function () {
          var sub = state.subscription;
          var before = sub && sub.pricing && sub.pricing.total ? sub.pricing.total.amount : 0;
          var offer = Math.max(1, Math.round(before * 0.6 * 100)) / 100;
          return {
            status: 'ok', operation: 'offer', percentOff: 40,
            previousPrice: before, offerPrice: offer,
            verified: true, refreshRequired: false
          };
        });
      },

      skipNextDelivery: function (id, opts) {
        return respond(function () {
          var s = state.subscription;
          s.nextOrderDate = addDays(s.nextOrderDate, s.intervalDays);
          return projectSubscription();
        });
      },

      // POST /update-next-billing-date — push out by N days
      delayNextDelivery: function (id, days, opts) {
        return respond(function () {
          var s = state.subscription;
          s.nextOrderDate = addDays(s.nextOrderDate, days);
          return projectSubscription();
        });
      },

      // POST /update-next-billing-date — set an explicit date
      rescheduleNextDelivery: function (id, isoDate, opts) {
        return respond(function () {
          state.subscription.nextOrderDate = isoDate;
          return projectSubscription();
        });
      },

      // POST /cancel-subscription { CustomerIds, Notes }
      cancel: function (id, reasonCode, note, opts) {
        return respond(function () {
          var s = state.subscription;
          s.status = 'cancelled';
          s.cancelledOn = TODAY;
          s.cancelReason = reasonCode;
          return projectSubscription();
        });
      },

      // POST /activate-subscription { CustomerIds, Notes }
      reactivate: function (id, startOffsetDays, opts) {
        return respond(function () {
          var s = state.subscription;
          s.status = 'active';
          s.cancelledOn = null;
          s.nextOrderDate = addDays(TODAY, startOffsetDays || 0);
          return projectSubscription();
        });
      }
    };
  }

  VetPetsPortal.createMockAdapter = createMockAdapter;

  /* ===============================================================
   * Live adapter — cookie-free App Proxy session
   * ===============================================================
   * Shopify strips Cookie from an App Proxy request and Set-Cookie from the
   * response, so the session cannot be a cookie. It is an opaque token the
   * server mints and this file holds in sessionStorage, sent in a JSON body.
   *
   *   POST {base}/auth/request-link  { email }        -> 202, always neutral
   *   POST {base}/auth/exchange      { vp_handoff }   -> { session }
   *   POST {base}/portal/subscription { session }     -> portal view model
   *   POST {base}/auth/logout        { session }      -> 200, idempotent
   *
   * Rules this file must keep:
   *   - the session is the ONLY thing stored, and only in sessionStorage.
   *     Never localStorage, never a cookie, never a URL, never the DOM;
   *   - the email, the Phoenix CustomerId and the magic-link token are never
   *     stored and never sent — the server resolves identity from the session;
   *   - nothing is logged. A console line is readable by anyone with the tab
   *     open, and these values are credentials.
   * --------------------------------------------------------------- */

  /** Session lives for the tab, and dies with it. */
  var SESSION_KEY = 'vp_portal_session';

  function sessionStore() {
    // A private window, disabled storage or a sandboxed frame all throw on
    // access rather than returning null, so every use is guarded.
    return {
      get: function () {
        try { return window.sessionStorage.getItem(SESSION_KEY); } catch (e) { return null; }
      },
      set: function (value) {
        try { window.sessionStorage.setItem(SESSION_KEY, value); } catch (e) { /* ephemeral session */ }
      },
      clear: function () {
        try { window.sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* nothing to clear */ }
      }
    };
  }

  VetPetsPortal.sessionStore = sessionStore;

  /**
   * Remove the handoff code from the address bar before anything else runs.
   *
   * A URL reaches history, the Referer header and any analytics script on the
   * page. The code is single-use and expires in a minute, but it should not be
   * sitting in the location bar for either of those to read.
   */
  function takeHandoffFromUrl() {
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (e) {
      return null;
    }

    var code = params.get('vp_handoff');
    if (!code) return null;

    params.delete('vp_handoff');
    var query = params.toString();
    var clean = window.location.pathname + (query ? '?' + query : '') + window.location.hash;

    try {
      window.history.replaceState(window.history.state, '', clean);
    } catch (e) {
      // replaceState can be unavailable in a sandboxed context. The code is
      // still consumed server-side on first use, so this is not fatal.
    }

    return code;
  }

  VetPetsPortal.takeHandoffFromUrl = takeHandoffFromUrl;

  /**
   * The one unpublished theme a test link is allowed to return to.
   *
   * Duplicated deliberately: the server holds the authoritative allowlist and
   * this is only a client-side gate that keeps a production storefront from
   * ever asking for a preview return in the first place. When the portal
   * ships on the published theme the rendered id will not match, and the
   * behaviour disappears on its own with no code change.
   */
  var DEV_PREVIEW_THEME_ID = '181692858635';

  VetPetsPortal.DEV_PREVIEW_THEME_ID = DEV_PREVIEW_THEME_ID;

  /**
   * The theme identity Liquid rendered into the page.
   *
   * NOT read from the address bar. Shopify turns `preview_theme_id` into the
   * HttpOnly `_shopify_essential` cookie and 302s to a clean URL, so the
   * parameter is already gone by the time the portal boots — reading
   * `location.search` here finds nothing and every test link comes back to the
   * live theme. The section emits `data-spp-theme-id` from Liquid instead,
   * server-side, where the preview cookie is honoured.
   */
  function renderedThemeId() {
    try {
      var doc = window.document;
      var root = doc && doc.querySelector ? doc.querySelector('[data-spp-portal]') : null;
      return root ? root.getAttribute('data-spp-theme-id') : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * The unpublished theme this page is being previewed on, if any.
   *
   * An unpublished theme is only reachable with `preview_theme_id`, and the
   * published theme carries no portal template at all, so a test link has to
   * come back to the same preview or it renders the ordinary page.
   *
   * Anything that is not exactly the dev theme returns null, so a request from
   * the published storefront carries no preview field at all and the server
   * builds its canonical destination. The server's own exact allowlist stays
   * the authority; this never widens what it will accept.
   *
   * The argument exists for tests and for an explicit override; omit it and
   * the value comes from the rendered page.
   */
  function previewThemeId(themeId) {
    var raw = arguments.length > 0 ? themeId : renderedThemeId();
    var value = raw === null || raw === undefined ? '' : String(raw).trim();
    return value === DEV_PREVIEW_THEME_ID ? value : null;
  }

  VetPetsPortal.renderedThemeId = renderedThemeId;
  VetPetsPortal.previewThemeId = previewThemeId;

  VetPetsPortal.createHttpAdapter = function (options) {
    var opts = options || {};
    var base = opts.basePath || '/apps/subscriptions';
    var store = opts.sessionStore || sessionStore();
    var fetchImpl = opts.fetchImpl || function () {
      return window.fetch.apply(window, arguments);
    };
    // The live portal counts days from the REAL current date. `opts.today` is
    // the prototype's frozen date and belongs to mock mode; letting it reach
    // here made "34 days away" appear on a date 25 days from the delivery.
    // Local calendar date, not UTC: the customer counts sleeps, not hours.
    var today = opts.today || VetPetsPortal.dates.toISO(new Date());
    // Resolved once, from the rendered page, never from the URL.
    var previewReturn = 'themeId' in opts ? previewThemeId(opts.themeId) : previewThemeId();

    /** One place that talks to the backend. Same-origin, first-party. */
    function post(path, body) {
      return fetchImpl(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Same-origin: the browser sends Origin automatically, which is both
        // what Shopify needs to sign the request and what the server checks.
        credentials: 'same-origin',
        body: JSON.stringify(body || {})
      }).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          return { status: res.status, ok: res.ok, data: data };
        });
      }, function () {
        throw PortalError('network', 'The portal could not be reached.');
      });
    }

    function requireSession() {
      var token = store.get();
      if (!token) throw PortalError('unauthenticated', 'Sign in to view your subscription.');
      return token;
    }

    /**
     * A key that identifies one ATTEMPT, not one intention.
     *
     * Reused verbatim by a retry of the same attempt, so the server can tell a
     * duplicate from a fresh request. The caller passes `opts.idempotencyKey`
     * when retrying; otherwise a new one is minted.
     */
    function idempotencyKey(opts) {
      if (opts && typeof opts.idempotencyKey === 'string' && opts.idempotencyKey.length >= 8) {
        return opts.idempotencyKey;
      }
      // Falling through here means the caller did not supply one. That is how
      // a single confirmation became two independently keyed skips: two calls,
      // two fresh keys, and a server with no way to see they meant the same
      // thing. The controller now owns the key for the whole attempt; this
      // remains only for callers with nothing to retry.

      var random = 'xxxxxxxxxxxx'.replace(/x/g, function () {
        return Math.floor(Math.random() * 16).toString(16);
      });
      return 'vp-' + Date.now().toString(36) + '-' + random;
    }

    /**
     * Perform one mutation.
     *
     * The response body IS the refreshed portal view, so the cached read is
     * dropped and the new state adopted in one step — no second round trip,
     * and no window in which the UI shows the pre-write state.
     */
    function mutate(path, fields, opts) {
      var body;
      try {
        body = {
          session: requireSession(),
          confirm: true,
          idempotencyKey: idempotencyKey(opts)
        };
        // The next-delivery date the caller was SHOWING when the customer
        // confirmed. The server compares it with what Phoenix actually holds
        // and refuses the request if they disagree, so a request composed
        // against a subscription that has since moved cannot move it again.
        if (opts && typeof opts.expectedNextBillingDate === 'string') {
          body.expectedNextBillingDate = opts.expectedNextBillingDate;
        }
      } catch (e) {
        // Rejected, never thrown synchronously. Every caller handles these
        // with .catch(), and a synchronous throw would sail straight past it.
        return Promise.reject(e);
      }
      for (var k in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) body[k] = fields[k];
      }

      return post(path, body).then(function (r) {
        if (r.status === 401) {
          store.clear();
          pending = null;
          throw PortalError('unauthenticated', 'Your session has expired.');
        }
        // 403, not 5xx: Shopify's App Proxy replaces an upstream 5xx with the
        // storefront's themed error page, so a gated capability has to answer
        // with a status the proxy passes through.
        if (r.status === 403 && r.data && r.data.error === 'not_enabled') {
          throw PortalError('not_enabled', 'That is not available yet.');
        }
        if (r.status === 409 && r.data && r.data.error === 'already_applied') {
          // A duplicate the server refused: this change is already in place.
          // Never a failure — for the customer it worked, and calling it a
          // failure is what would prompt them to do it a third time.
          throw PortalError('already_applied', 'That has already been done.');
        }
        if (r.status === 400 && r.data && r.data.error === 'expected_state_required') {
          // This build is talking to a newer server, or the view is stale.
          throw PortalError('stale_view', 'Refresh to see the latest, then try again.');
        }
        if (r.status === 409 && r.data && r.data.error === 'operation_in_progress') {
          // A double-click. The first request is still running; saying
          // "failed" would be wrong and a second write would be worse.
          throw PortalError('in_progress', 'That is already being processed.');
        }
        if (r.status === 504) {
          // A timed-out write may or may not have applied, so the copy must
          // not claim either. The customer is told to check, not told a
          // result we do not have.
          throw PortalError('timeout', 'That is taking longer than expected. Refresh to check.');
        }
        if (!r.ok || !r.data) {
          throw PortalError(
            (r.data && r.data.error) || 'server',
            'We could not complete that just now.'
          );
        }

        // The write APPLIED but the server could not re-read Phoenix. This is
        // a success with a stale view, never a failure: the customer's change
        // is real. Drop the cached read so the next one goes to the server,
        // and let the caller show a refresh prompt.
        if (r.data.refreshRequired) {
          pending = null;
          return { refreshRequired: true };
        }

        if (!r.data.view) {
          throw PortalError('server', 'We could not complete that just now.');
        }

        // Adopt the server's re-read as the new truth.
        pending = Promise.resolve(r.data.view);
        var projected = projectSubscription(r.data.view);
        if (!projected) throw PortalError('no_subscription', 'No active subscription found.');
        return projected;
      });
    }

    /** Cache one portal read per load; six adapter calls, one request. */
    var pending = null;

    function readPortal(force) {
      if (pending && !force) return pending;

      pending = post('/portal/subscription', { session: requireSession() }).then(function (r) {
        if (r.status === 401) {
          store.clear();
          pending = null;
          throw PortalError('unauthenticated', 'Your session has expired.');
        }
        if (!r.ok || !r.data) {
          pending = null;
          throw PortalError(
            (r.data && r.data.error) || 'server',
            'The portal is temporarily unavailable.'
          );
        }
        return r.data;
      }, function (err) {
        pending = null;
        throw err;
      });

      return pending;
    }

    function daysUntil(iso) {
      if (!iso || !today) return 0;
      try {
        return Math.max(0, VetPetsPortal.dates.daysBetween(today, iso));
      } catch (e) {
        return 0;
      }
    }

    /**
     * Map the server view model into the shape the controller renders.
     *
     * Only fields the server actually returns are populated. Anything Phoenix
     * does not support on this path — line prices, totals, delivery counts —
     * stays null so the UI renders nothing rather than a fabricated number.
     */
    function projectSubscription(view) {
      if (!view || view.state !== 'subscription') return null;
      var sub = view.subscription || {};
      var charge = sub.upcomingCharge || {};
      var cadence = sub.cadence || {};
      var chargeMoney = charge.state === 'available'
        ? money(charge.amount, charge.currencyCode)
        : null;

      return {
        id: sub.subscriptionId || null,
        reference: sub.subscriptionId || null,
        status: sub.status || null,
        name: null,
        startedOn: null,
        deliveriesSoFar: null,
        intervalDays: cadence.state === 'available' ? cadence.intervalDays : null,
        nextOrderDate: sub.nextBillingDate || null,
        cancelledOn: null,
        daysUntilNextOrder: daysUntil(sub.nextBillingDate),
        currencyCode: chargeMoney ? chargeMoney.currencyCode : null,
        lines: (sub.lines || []).map(function (l) {
          return {
            id: l.variantId || l.productId || null,
            // Kept separately so the theme can resolve a product image from
            // the Shopify ids Phoenix carries. The adapter itself resolves
            // nothing: it has no catalogue and must not invent one.
            productId: l.productId || null,
            variantId: l.variantId || null,
            title: l.title || '',
            subtitle: null,
            quantity: l.quantity,
            image: '',
            imagePending: true,
            unitPrice: null,
            linePrice: null
          };
        }),
        pricing: {
          subtotal: null,
          discount: null,
          shipping: null,
          // The only authoritative amount is the scheduled rebill.
          total: chargeMoney
        },
        address: sub.deliveryAddress || null,
        payment: sub.payment || null,
        shippingFree: null,
        discountRate: null
      };
    }

    return {
      kind: 'http',
      isMock: false,
      mode: 'live',

      getCurrency: function () { return null; },
      getSupportedCurrencies: function () { return VetPetsPortal.SUPPORTED_CURRENCIES.slice(); },
      getToday: function () { return today; },

      /* --- auth --- */

      hasSession: function () { return !!store.get(); },

      /**
       * Drop the stored session without calling the server.
       *
       * Used when the server has already told us the token is worthless (401)
       * or when there was never one to begin with. Posting a logout for a token
       * the server has never heard of would be a pointless round trip on the
       * path back to the sign-in screen.
       */
      clearSession: function () {
        store.clear();
        pending = null;
      },

      requestMagicLink: function (email) {
        var body = { email: email };
        // Only ever sent while testing on an unpublished theme; the server
        // drops anything that is not its configured id.
        if (previewReturn) body.preview_theme_id = previewReturn;

        return post('/auth/request-link', body).then(function (r) {
          // 202 is the only success, and it is deliberately neutral: it says
          // nothing about whether the address is a customer.
          if (r.status === 202) return { ok: true, expiresInMinutes: 15 };
          if (r.status === 429) throw PortalError('rate_limited', 'Too many attempts. Try again shortly.');
          if (r.status === 400) throw PortalError('invalid_email', 'Enter a valid email address.');
          throw PortalError('server', 'We could not send the link just now.');
        });
      },

      /**
       * Trade the one-time handoff for a session.
       *
       * The code is already out of the address bar by the time this runs.
       */
      exchangeHandoff: function (code) {
        return post('/auth/exchange', { vp_handoff: code }).then(function (r) {
          if (r.status === 200 && r.data && r.data.session) {
            store.set(r.data.session);
            pending = null;
            return { ok: true };
          }
          store.clear();
          // Expired, replayed and unknown are one failure, as the server
          // intends: the page returns to sign-in either way.
          throw PortalError('expired_link', 'That sign-in link is no longer valid.');
        });
      },

      signOut: function () {
        var token = store.get();
        store.clear();
        pending = null;
        if (!token) return Promise.resolve({ ok: true });
        // Idempotent server-side, so a failure here changes nothing that
        // matters: the token is already gone from this browser.
        return post('/auth/logout', { session: token }).then(
          function () { return { ok: true }; },
          function () { return { ok: true }; }
        );
      },

      /* --- reads: six controller calls, one backend request --- */

      getCustomer: function () {
        return readPortal().then(function (view) {
          // firstName is the ONLY identifying value the server returns, and it
          // is null whenever Phoenix has nothing usable. The address, the full
          // name, the email and the CustomerId are never sent, and this file
          // never asks for them.
          var first = view.customer ? view.customer.firstName : null;
          return {
            firstName: typeof first === 'string' && first.length > 0 ? first : null,
            email: null,
            name: null,
            state: view.state
          };
        });
      },

      getSubscription: function () {
        return readPortal().then(function (view) {
          var projected = projectSubscription(view);
          if (!projected) throw PortalError('no_subscription', 'No active subscription found.');
          return projected;
        });
      },

      listSubscriptions: function () {
        return readPortal().then(function (view) {
          var projected = projectSubscription(view);
          return { active: projected ? [projected] : [], inactive: [] };
        });
      },

      listDeliveries: function () {
        return readPortal().then(function (view) {
          var projected = projectSubscription(view);
          if (!projected) return { upcoming: null, past: [] };
          return {
            upcoming: {
              date: projected.nextOrderDate,
              title: 'Next delivery',
              items: projected.lines.map(function (l) {
                return l.title + ' ×' + l.quantity;
              }).join(', '),
              total: projected.pricing.total,
              status: projected.status === 'active' ? 'Scheduled' : 'Cancelled'
            },
            past: (((view.subscription || {}).recentPayments) || []).map(function (p) {
              return {
                orderId: p.orderNumber || null,
                date: p.date || null,
                items: '',
                amount: (p.amount != null && p.currencyCode)
                  ? money(p.amount, p.currencyCode)
                  : null,
                status: p.status || ''
              };
            })
          };
        });
      },

      /* --- mutations ---------------------------------------------------
       *
       * Five operations, each posting to its own first-party route. The
       * browser sends WHAT to do and never WHOSE subscription: there is no
       * CustomerId parameter here, and the server ignores one if a caller
       * invents it.
       *
       * Every call carries:
       *   confirm: true     the customer said so; a mutation is never a side
       *                     effect of a render
       *   idempotencyKey    a per-attempt key, so a double-click, a flaky
       *                     connection or a retry cannot apply twice
       *
       * The server answers with the RE-READ subscription, not an echo, so the
       * UI renders what Phoenix now holds rather than what we asked for.
       * ----------------------------------------------------------------- */

      /* --- Cancellation Retention V2 -------------------------------- *
       * Neither of these is a Phoenix mutation. The first writes to our own
       * store; the second currently writes nothing anywhere.
       * --------------------------------------------------------------- */

      /**
       * Record why the customer is leaving, at the moment they say so.
       *
       * Called on the way THROUGH the journey, not at the end, because the
       * customers it saves never reach an end. `note` travels only for
       * "other" — the server ignores it otherwise.
       */
      recordCancelReason: function (reasonCode, note) {
        var body;
        try {
          body = { session: requireSession(), reason: reasonCode };
        } catch (e) {
          return Promise.reject(e);
        }
        if (typeof note === 'string' && note.length) body.note = note;
        return post('/portal/cancel-reason', body).then(function (r) {
          if (r.status === 401) {
            store.clear();
            pending = null;
            throw PortalError('unauthenticated', 'Your session has expired.');
          }
          if (!r.ok) throw PortalError('server', 'We could not save that just now.');
          return r.data;
        });
      },

      /** Settle what became of the reason: saved_gap, saved_offer, cancelled. */
      recordCancelOutcome: function (outcome) {
        var body;
        try {
          body = { session: requireSession(), outcome: outcome };
        } catch (e) {
          return Promise.reject(e);
        }
        // Best effort by design: an analytics write must never block or fail
        // a customer's actual subscription change.
        return post('/portal/cancel-reason', body).then(
          function (r) { return r.data; },
          function () { return null; }
        );
      },

      /**
       * Accept the 40%-off-next-delivery offer.
       *
       * GATED. There is no proven Phoenix operation that discounts one
       * delivery and then restores the standing price, so the server answers
       * `offer_unavailable` and nothing is applied. This method exists in its
       * final shape so that connecting it later changes the server only.
       */
      acceptRetentionOffer: function (opts) {
        var body;
        try {
          body = { session: requireSession(), confirm: true };
        } catch (e) {
          return Promise.reject(e);
        }
        if (opts && typeof opts.idempotencyKey === 'string') {
          body.idempotencyKey = opts.idempotencyKey;
        }
        return post('/portal/retention-offer', body).then(function (r) {
          if (r.status === 401) {
            store.clear();
            pending = null;
            throw PortalError('unauthenticated', 'Your session has expired.');
          }
          if (r.status === 409 && r.data && r.data.error === 'offer_unavailable') {
            throw PortalError('offer_unavailable', 'That offer is not available right now.');
          }
          if (r.status === 409 && r.data && r.data.error === 'already_applied') {
            throw PortalError('already_applied', 'That discount is already on your next delivery.');
          }
          if (r.status === 409 && r.data && r.data.error === 'operation_in_progress') {
            throw PortalError('in_progress', 'That is already being processed.');
          }
          if (r.status === 504) {
            throw PortalError('timeout', 'That is taking longer than expected. Refresh to check.');
          }
          if (!r.ok) throw PortalError('server', 'We could not apply that just now.');
          return r.data;
        });
      },

      skipNextDelivery: function (id, opts) {
        return mutate('/portal/skip', {}, opts);
      },

      delayNextDelivery: function (id, days, opts) {
        return mutate('/portal/delay', { days: days }, opts);
      },

      rescheduleNextDelivery: function (id, isoDate, opts) {
        return mutate('/portal/reschedule', { date: isoDate }, opts);
      },

      cancel: function (id, reasonCode, note, opts) {
        // `note` is deliberately NOT forwarded. Free text a customer typed
        // would be written into a third-party billing system we do not
        // control; only the fixed reason code travels.
        return mutate('/portal/cancel', { reason: reasonCode }, opts);
      },

      reactivate: function (id, startOffsetDays, opts) {
        return mutate('/portal/reactivate', {}, opts);
      },

      /* --- loyalty: not part of this phase, and not faked --- */

      getLoyalty: function () {
        // VetPoints has no backend yet. Returning a number here would put a
        // fabricated balance in front of a real customer.
        return Promise.resolve(null);
      },

      listRewards: function () {
        return Promise.resolve([]);
      }
    };
  };

  /**
   * Single entry point the controller uses. Guarantees that live mode can
   * never silently fall back to mock data.
   */
  VetPetsPortal.createAdapter = function (config) {
    config = config || {};
    if (config.mode === 'live') return VetPetsPortal.createHttpAdapter(config);
    return createMockAdapter(config);
  };
})(window);
