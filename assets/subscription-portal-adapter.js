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
   * Live adapter — interface designed, implementation gated
   * ===============================================================
   * Implement against the SAME method names and return shapes as the
   * mock. Every call goes to a same-origin first-party path; the browser
   * never learns the Phoenix host and never sends a CustomerId.
   *
   *   POST {base}/auth/request-link   { email }        -> 202, always neutral
   *   POST {base}/auth/verify         { token }        -> sets session cookie
   *   POST {base}/auth/sign-out
   *   GET  {base}/me                                    -> customer profile
   *   GET  {base}/subscription                          -> subscription projection
   *   GET  {base}/deliveries                            -> upcoming + past
   *   GET  {base}/loyalty                               -> syncs ledger, then balance
   *   GET  {base}/loyalty/rewards                       -> catalogue + affordability
   *   POST {base}/loyalty/redemptions { rewardId }      -> pending_manual
   *   POST {base}/subscription/skip                     -> /update-next-billing-date
   *   POST {base}/subscription/delay      { days }      -> /update-next-billing-date
   *   POST {base}/subscription/reschedule { date }      -> /update-next-billing-date
   *   POST {base}/subscription/cancel     { reason }    -> /cancel-subscription
   *   POST {base}/subscription/reactivate { startDate } -> /activate-subscription
   *
   * Every mutation sends `Idempotency-Key`. The server maps it to a stable
   * Phoenix request-id so a retry cannot double-apply.
   * --------------------------------------------------------------- */
  VetPetsPortal.createHttpAdapter = function (options) {
    var base = (options && options.basePath) || '/apps/subscriptions';
    throw PortalError(
      'not_implemented',
      'The live adapter is not wired up yet. It must call ' + base +
      ' (same-origin, first-party) and is blocked on the secure backend being ' +
      'approved and deployed. No Phoenix credential may ever reach this file.'
    );
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
