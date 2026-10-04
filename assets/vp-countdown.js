/* VetPets shared countdown module
 * ------------------------------------------------------------------
 * ONE clock for every pre-lander / offer-page countdown. Pages never keep
 * their own timer maths; they hand their [data-*-cd="d|h|m|s"] nodes to
 * VPCountdown.mount(nodes, opts).
 *
 *   mode 'daily-et' (Original/evergreen): counts down to 23:59:59
 *     America/New_York tonight, then restarts for the next New York day.
 *     DST-safe (23h/25h days) because the end instant is derived from the
 *     real UTC offset at the next New York midnight, not from 24h maths.
 *   mode 'fixed' (World Animal Week): counts to opts.deadlineMs.
 *
 * Every page computes from Date.now() on each tick, so any two pages open in
 * the same browser at the same moment show identical values. One shared
 * setTimeout chain (never setInterval) is aligned to second boundaries; a
 * second mount() reuses it, and returning to a hidden tab re-syncs at once.
 * Remaining time is clamped at 0 — it can never go negative.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VPCountdown = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TZ = 'America/New_York';
  var fmt = null;

  /* ---- New York UTC offset (ms) at an instant ---------------------- */
  function nthSundayUtc(year, month0, n) { // 2:00 local handled by caller
    var first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  }
  function ruleOffsetMs(ms) { // fallback: current US DST rules
    var y = new Date(ms).getUTCFullYear();
    var start = Date.UTC(y, 2, nthSundayUtc(y, 2, 2), 7);  // 02:00 EST = 07:00Z
    var end = Date.UTC(y, 10, nthSundayUtc(y, 10, 1), 6);   // 02:00 EDT = 06:00Z
    return (ms >= start && ms < end ? -4 : -5) * 3600000;
  }
  function tzOffsetMs(ms) {
    try {
      if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric',
          day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
        });
      }
      var p = {};
      fmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = parseInt(x.value, 10); });
      if (!p.year || !p.month || !p.day) throw new Error('tz parts');
      var asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
      return asUtc - Math.floor(ms / 1000) * 1000;
    } catch (e) {
      return ruleOffsetMs(ms);
    }
  }

  /* ---- first instant of the NEXT New York calendar day -------------- */
  function nextMidnightNY(nowMs) {
    var local = new Date(nowMs + tzOffsetMs(nowMs)); // wall clock as UTC fields
    var naive = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 0, 0, 0);
    var utc = naive - tzOffsetMs(naive);
    var o2 = tzOffsetMs(utc);
    if (naive - o2 !== utc) utc = naive - o2; // offset changed between guess and result
    return utc;
  }

  function remainingSeconds(opts, nowMs) {
    nowMs = nowMs === undefined ? Date.now() : nowMs;
    var end;
    if (opts && opts.mode === 'fixed') {
      end = Number(opts.deadlineMs);
      if (!isFinite(end)) return 0;
    } else {
      end = nextMidnightNY(nowMs) - 1000; // 23:59:59
    }
    return Math.max(0, Math.ceil((end - nowMs) / 1000)); // ceil: a partial second still counts as a second left
  }

  function split(left) {
    left = Math.max(0, left | 0);
    return {
      d: Math.floor(left / 86400),
      h: Math.floor((left % 86400) / 3600),
      m: Math.floor((left % 3600) / 60),
      s: left % 60
    };
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /* ---- shared ticker ------------------------------------------------ */
  var subs = [];      // { el, attr, opts }
  var timer = null;
  var visHooked = false;

  function paint() {
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      var key = s.el.getAttribute(s.attr);
      var v = split(remainingSeconds(s.opts))[key];
      if (v === undefined) continue;
      var txt = pad(v);
      if (s.el.textContent !== txt) s.el.textContent = txt;
    }
  }
  function schedule() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; paint(); schedule(); }, 1000 - (Date.now() % 1000) + 15);
  }
  function hookVisibility() {
    if (visHooked || typeof document === 'undefined' || !document.addEventListener) return;
    visHooked = true;
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && subs.length) { paint(); schedule(); }
    });
  }

  function mount(nodes, opts) {
    opts = opts || {};
    var attr = opts.attr;
    if (!attr || !nodes) return 0;
    var list = Array.prototype.slice.call(nodes);
    list.forEach(function (el) {
      for (var i = 0; i < subs.length; i++) {
        if (subs[i].el === el) { subs[i].attr = attr; subs[i].opts = opts; return; } // never double-bind
      }
      subs.push({ el: el, attr: attr, opts: opts });
    });
    if (!list.length) return 0;
    paint();
    schedule();
    hookVisibility();
    return list.length;
  }

  return {
    TZ: TZ,
    mount: mount,
    remainingSeconds: remainingSeconds,
    nextMidnightNY: nextMidnightNY,
    tzOffsetMs: tzOffsetMs,
    ruleOffsetMs: ruleOffsetMs,
    split: split,
    _subscriberCount: function () { return subs.length; },
    _timerActive: function () { return timer !== null; },
    _reset: function () { subs = []; if (timer !== null) clearTimeout(timer); timer = null; }
  };
});
