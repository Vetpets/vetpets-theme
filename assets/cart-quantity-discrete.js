/**
 * Cart line items: custom quantity sequences via data-allowed-quantities="1,2,4"
 * (HTML step alone cannot skip a middle value). Registers before deferred main.js.
 */
(function () {
  var SEL = '[data-allowed-quantities]';

  function parseAllowed(input) {
    return input.dataset.allowedQuantities.split(',').map(Number).sort(function (a, b) {
      return a - b;
    });
  }

  function nearestAllowed(value, allowed) {
    if (allowed.indexOf(value) !== -1) return value;
    var best = allowed[0];
    var bestDist = Math.abs(value - best);
    for (var i = 0; i < allowed.length; i++) {
      var a = allowed[i];
      var d = Math.abs(value - a);
      if (d < bestDist || (d === bestDist && a < best)) {
        best = a;
        bestDist = d;
      }
    }
    return best;
  }

  function stepFrom(value, allowed, dir) {
    var idx = allowed.indexOf(value);
    if (idx === -1) return nearestAllowed(value, allowed);
    var next = idx + dir;
    if (next < 0) return allowed[0];
    if (next >= allowed.length) return allowed[allowed.length - 1];
    return allowed[next];
  }

  function normalizeInput(input) {
    if (!input || !input.dataset || !input.dataset.allowedQuantities) return;
    var allowed = parseAllowed(input);
    var v = parseInt(input.value, 10);
    if (isNaN(v)) v = allowed[0];
    var fixed = nearestAllowed(v, allowed);
    if (fixed !== v) {
      input.value = fixed;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function normalizeAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(SEL).forEach(normalizeInput);
  }

  document.addEventListener(
    'click',
    function (e) {
      var btn = e.target.closest('.quantity__button');
      if (!btn) return;
      var host = btn.closest('quantity-input');
      if (!host) return;
      var input = host.querySelector(SEL);
      if (!input) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      var allowed = parseAllowed(input);
      var v = parseInt(input.value, 10);
      if (isNaN(v)) v = allowed[0];
      v = nearestAllowed(v, allowed);

      var name = btn.getAttribute('name');
      var next = name === 'plus' ? stepFrom(v, allowed, 1) : stepFrom(v, allowed, -1);
      if (next !== v) {
        input.value = next;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    true
  );

  document.addEventListener(
    'change',
    function (e) {
      var input = e.target;
      if (!input.matches || !input.matches(SEL)) return;
      var allowed = parseAllowed(input);
      var v = parseInt(input.value, 10);
      if (isNaN(v)) v = allowed[0];
      var fixed = nearestAllowed(v, allowed);
      if (fixed !== v) input.value = fixed;
    },
    true
  );

  document.addEventListener('DOMContentLoaded', function () {
    normalizeAll(document);
    var moTimer;
    var mo = new MutationObserver(function () {
      clearTimeout(moTimer);
      moTimer = setTimeout(function () {
        document.querySelectorAll(SEL).forEach(function (input) {
          var allowed = parseAllowed(input);
          var v = parseInt(input.value, 10);
          if (!isNaN(v) && allowed.indexOf(v) === -1) normalizeInput(input);
        });
      }, 0);
    });
    if (document.body) mo.observe(document.body, { childList: true, subtree: true });
  });

  document.addEventListener('shopify:section:load', function (e) {
    if (e.target) normalizeAll(e.target);
  });
})();
