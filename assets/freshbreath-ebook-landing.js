(function () {
  var root = document.getElementById('freshbreath-ebook-landing');
  if (!root || root.dataset.fbInit) return;
  root.dataset.fbInit = 'true';

  /* ---------- FAQ accordion ---------- */
  var faqItems = Array.prototype.slice.call(root.querySelectorAll('[data-fb-faq-item]'));
  faqItems.forEach(function (item) {
    var btn = item.querySelector('[data-fb-faq-toggle]');
    btn.addEventListener('click', function () {
      var isOpen = item.getAttribute('data-open') === 'true';
      faqItems.forEach(function (i2) {
        i2.setAttribute('data-open', 'false');
        i2.querySelector('[data-fb-faq-toggle]').setAttribute('aria-expanded', 'false');
        i2.querySelector('[data-fb-faq-sign]').textContent = '+';
      });
      if (!isOpen) {
        item.setAttribute('data-open', 'true');
        btn.setAttribute('aria-expanded', 'true');
        item.querySelector('[data-fb-faq-sign]').textContent = '−';
      }
    });
  });

  /* ---------- Look inside: tabs + spreads ---------- */
  var SPREADS = JSON.parse(root.querySelector('#fb-spreads-data').textContent);
  var tabs = Array.prototype.slice.call(root.querySelectorAll('[data-fb-tab]'));
  var pagesWrap = root.querySelector('[data-fb-spread-pages]');
  var labelEl = root.querySelector('[data-fb-spread-label]');
  var titleEl = root.querySelector('[data-fb-spread-title]');
  var textEl = root.querySelector('[data-fb-spread-text]');
  var curTab = 0;

  function flatPages() {
    var out = [];
    SPREADS.forEach(function (s, si) {
      s.pages.forEach(function (p) { out.push({ n: p.n, src: p.src, si: si, label: s.label }); });
    });
    return out;
  }

  function renderSpread(i) {
    curTab = i;
    var s = SPREADS[i];
    var nums = s.pages.map(function (p) { return p.n; });
    tabs.forEach(function (t, ti) { t.setAttribute('aria-selected', ti === i ? 'true' : 'false'); });
    labelEl.textContent = nums.length > 2
      ? 'Pages ' + nums[0] + '–' + nums[nums.length - 1]
      : 'Pages ' + nums.join(' & ');
    titleEl.textContent = s.title;
    textEl.textContent = s.text;
    pagesWrap.innerHTML = '';
    var flat = flatPages();
    s.pages.forEach(function (p) {
      var fi = flat.findIndex(function (fp) { return fp.n === p.n && fp.si === i; });
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fb-look-page';
      btn.setAttribute('aria-label', 'Enlarge page ' + p.n);
      btn.innerHTML = '<img src="' + p.src + '" alt="Page ' + p.n + ' of Fresh Breath in 30 Days, ' + s.title + '">' +
        '<span class="fb-look-page-tag">Page ' + p.n + ' · Enlarge</span>';
      btn.addEventListener('click', function () { openLightbox(fi); });
      pagesWrap.appendChild(btn);
    });
  }
  tabs.forEach(function (t, i) { t.addEventListener('click', function () { renderSpread(i); }); });
  var prevTabBtn = root.querySelector('[data-fb-prev-tab]');
  var nextTabBtn = root.querySelector('[data-fb-next-tab]');
  if (prevTabBtn) prevTabBtn.addEventListener('click', function () { renderSpread((curTab - 1 + SPREADS.length) % SPREADS.length); });
  if (nextTabBtn) nextTabBtn.addEventListener('click', function () { renderSpread((curTab + 1) % SPREADS.length); });

  /* ---------- lightbox ---------- */
  var lightbox = root.querySelector('[data-fb-lightbox]');
  var lbImg = lightbox.querySelector('img');
  var lbCaption = lightbox.querySelector('[data-fb-lb-caption]');
  var lbIndex = -1;

  function openLightbox(i) {
    var flat = flatPages();
    lbIndex = i;
    var p = flat[i];
    lbImg.src = p.src;
    lbImg.alt = 'Page ' + p.n + ' of Fresh Breath in 30 Days';
    lbCaption.textContent = p.label + ' · Page ' + p.n;
    lightbox.setAttribute('data-open', 'true');
    if (p.si !== curTab) renderSpread(p.si);
  }
  function closeLightbox() { lightbox.setAttribute('data-open', 'false'); lbIndex = -1; }
  function stepLightbox(d) {
    if (lbIndex < 0) return;
    var flat = flatPages();
    openLightbox((lbIndex + d + flat.length) % flat.length);
  }
  root.querySelector('[data-fb-lb-close]').addEventListener('click', closeLightbox);
  root.querySelector('[data-fb-lb-prev]').addEventListener('click', function (e) { e.stopPropagation(); stepLightbox(-1); });
  root.querySelector('[data-fb-lb-next]').addEventListener('click', function (e) { e.stopPropagation(); stepLightbox(1); });
  lightbox.addEventListener('click', function (e) { if (e.target === lightbox) closeLightbox(); });
  lbImg.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('keydown', function (e) {
    if (lbIndex < 0) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') stepLightbox(1);
    if (e.key === 'ArrowLeft') stepLightbox(-1);
  });

  renderSpread(0);

  /* ---------- sticky bar ---------- */
  var heroEl = root.querySelector('[data-fb-hero]');
  var finalEl = root.querySelector('[data-fb-final]');
  var sticky = root.querySelector('[data-fb-sticky]');
  if (heroEl && finalEl && sticky) {
    var onScroll = function () {
      var pastHero = heroEl.getBoundingClientRect().bottom < 0;
      var beforeFinal = finalEl.getBoundingClientRect().top > window.innerHeight;
      sticky.setAttribute('data-visible', (pastHero && beforeFinal) ? 'true' : 'false');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
