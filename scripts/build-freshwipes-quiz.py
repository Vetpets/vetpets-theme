"""Build sections/freshwipes-quiz.liquid from the approved Claude Design export.

Source of truth: Claude Design project "EyeWipes reference page and assets",
file "FreshWipes Quiz v4.dc.html" (founder-approved FreshWipes personalised quiz).

The page runs the design's own template + logic with Claude Design's runtime
(assets/fwq-dc-runtime.js, unmodified) on React 18.3.1 served from theme assets
(no CDN, no Babel). Only these changes are made to the approved export:

  template
  - design-tool includes removed from <helmet> (DS fonts/bundle, image-slot.js);
    Geist is self-hosted in assets/fwq-quiz.css
  - <image-slot> (design-tool image placeholder) -> plain <img>, same src/fit/radius
  - ./assets/<file> -> theme asset fwq-<file> (resolved in Liquid)
  logic
  - prices come from Kaching through window.FWQK (assets/fwq-kaching.js), never
    typed: the design's placeholder prices are removed
  - Bundle 1 "FREE Shipping" only with Routine Care (Kaching: subscription-only gift);
    the FAQ "What is included" line says the same
  - the design-review notices (CLAIM CHECK / PRICE CHECK) are off
  - UGC videos play from Shopify Files (video/mp4 renditions, original audio)
  - the offer CTA adds to cart through Kaching + the theme product form, keeps the
    design's vetpets:add-to-cart event and mirrors it to dataLayer

Usage: python3 scripts/build-freshwipes-quiz.py <FreshWipes Quiz v4.dc.html> <videos.json>
"""
import html, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'sections/freshwipes-quiz.liquid'


def sub1(s, a, b, what):
    if s.count(a) != 1:
        sys.exit('build-freshwipes-quiz: expected exactly one %s (found %d)' % (what, s.count(a)))
    return s.replace(a, b)


def main():
    src = Path(sys.argv[1]).read_text()
    vids = json.loads(Path(sys.argv[2]).read_text())
    i, j = src.index('<x-dc>'), src.index('</x-dc>') + len('</x-dc>')
    tpl = src[i:j]
    k = src.index('<script type="text/x-dc" data-dc-script')
    logic = src[k:src.index('</script>', k) + len('</script>')]

    # ---------------- template ----------------
    tpl = re.sub(r'\s*<link rel="stylesheet" href="_ds/[^"]+">', '', tpl)
    tpl = re.sub(r'\s*<script src="_ds/[^"]+"></script>', '', tpl)
    tpl = sub1(tpl, '\n  <script src="./image-slot.js"></script>', '', 'image-slot.js include')

    def img(m):
        attrs = dict(re.findall(r'([a-zA-Z-]+)="([^"]*)"', m.group(1)))
        style = attrs.get('style', '').rstrip(';')
        fit = attrs.get('fit', 'cover')
        radius = '50%' if attrs.get('shape') == 'circle' else (attrs.get('radius', '0') + 'px')
        style += ';object-fit:%s;border-radius:%s;display:block' % (fit, radius)
        out = '<img'
        if 'data-fq-src' in attrs:
            out += ' data-fq-src="%s"' % attrs['data-fq-src']
        if 'src' in attrs:
            out += ' src="%s"' % attrs['src']
        out += ' alt="%s" loading="lazy" style="%s">' % (attrs.get('placeholder', ''), style)
        return out
    tpl, n = re.subn(r'<image-slot ([^>]*)></image-slot>', img, tpl)
    if n != 7:
        sys.exit('build-freshwipes-quiz: expected 7 image-slots, found %d' % n)

    # ---------------- logic ----------------
    lg = logic
    # UGC: Shopify-hosted mp4 per testimonial (index 3)
    for name, url in vids.items():
        lg = re.sub(r"(\['%s', '[^']+', '[^']+')\]" % re.escape(name), lambda m: m.group(1) + ", '%s']" % url, lg, count=1)
    if lg.count("'https://cdn.shopify.com/videos/") != 5:
        sys.exit('build-freshwipes-quiz: UGC video mapping incomplete')
    lg = sub1(lg, "src: (p['ugc' + i + 'Url'] || '').trim(),",
              "src: (p['ugc' + i + 'Url'] || '').trim() || FQ_UGC_DEF[i - 1][3] || '',", 'UGC src')

    # performance only: let Shopify's CDN resize the large PNGs (same images; a 3.6 MB
    # e-book PNG is shown at 38 px, the demo posters are ~4.5 MB)
    for name, w in (('Kaching-Bundles-DigitalProduct_2FreshBreathin30Days.png?v=1777459254', 120),
                    ('ROUTINETRACKER.pdf_1.png?v=1776102536', 120),
                    ('fw-adv-M5-poster.png?v=1790608662', 900),
                    ('fw-adv-M7-poster.png?v=1790608662', 900)):
        lg = sub1(lg, name + "'", name + "&width=%d'" % w, name)

    # ---- quiz answers: nothing preselected (founder request 2026-10-12) ----
    # The count question used to preselect "1" for a named pet; every option now starts
    # neutral and is only marked after the user picks it.
    lg = sub1(lg, "const isOn = (k, v, dflt) => st.picked ? st.picked === v : (a[k] ? a[k] === v : v === dflt);",
              "const isOn = (k, v) => st.picked ? st.picked === v : (a[k] != null && a[k] === v);", 'isOn')
    lg = sub1(lg, "isOn('count', v, c.named ? '1' : null)", "isOn('count', v)", 'count default')
    # Loading the quiz is a fresh start: answers from an earlier load of this tab are cleared
    # (no restored or demo answers). Back/forward inside the quiz keeps chosen answers.
    lg = sub1(lg, "if ((p.previewStep ?? 'quiz') === 'result') this._applyPreview(); else this._restore();",
              "if ((p.previewStep ?? 'quiz') === 'result') this._applyPreview(); else this._freshStart();", 'restore on load')
    lg = sub1(lg, "  _restore() {",
              "  _freshStart() {\n"
              "    try { sessionStorage.removeItem(FQ_STORE); FQ_STORE_LEGACY.forEach(k => sessionStorage.removeItem(k)); } catch (e) {}\n"
              "    this.setState({ names: [''], a: {}, stepKey: 'dogs', editing: false, migrated: false, picked: null, tier: null, routine: true });\n"
              "  }\n"
              "  _restore() {", '_restore method')
    # Browser back/forward can never land past the first unanswered question.
    lg = sub1(lg, "const key = k === 'result' && !this._ready() ? this._firstOpen(this.state.names, this.state.a) : k;",
              "const first = this._firstOpen(this.state.names, this.state.a), st0 = this._steps();\n"
              "        const key = k === 'result' ? (this._ready() ? 'result' : first) : (first !== 'result' && st0.indexOf(k) > st0.indexOf(first) ? first : k);", 'popstate guard')

    # prices from Kaching
    a = lg.index('    const mk = (pre, d) => {')
    b = lg.index('    };', a) + len('    };')
    lg = lg[:a] + """    const mk = (pre, d) => {
      // Prices come from Kaching (assets/fwq-kaching.js), never typed here.
      const kp = window.FWQK ? window.FWQK.prices(pre === 'b1' ? 0 : 1) : {};
      return Object.assign(d, { oneTime: kp.one || '', routinePrice: kp.sub || '', compare: kp.compare || '', img: (p[pre + 'Img'] || '').trim() || d.img });
    };""" + lg[b:]
    # Bundle 1 free shipping is a Routine Care-only Kaching gift
    lg = sub1(lg, "gifts: [], freeShip: true,", "gifts: [], freeShip: !!st.routine,", 'bundle 1 freeShip')
    lg = sub1(lg, "The Buy 1, Get 1 Free kit has 2 jars (100 wipes) with free shipping.",
              "The Buy 1, Get 1 Free kit has 2 jars (100 wipes), with free shipping on Routine Care.", 'FAQ bundle line')
    lg = sub1(lg, "      pricesTodo,\n", "      pricesTodo: false,\n", 'pricesTodo')
    lg = sub1(lg, "claimsTodo: !p.claimsVerified,", "claimsTodo: false,", 'claimsTodo')
    lg = sub1(lg, "      offerCtaLabel: kit.cta,", "      offerCtaLabel: (window.FWQK && window.FWQK.busy()) ? 'ADDING TO CART…' : kit.cta,", 'CTA label')
    lg = lg.replace("(p.routineSellingPlanId || 'routine-care')", "(p.routineSellingPlanId || window.FWQK_PLAN || null)")

    # CTA -> Kaching + theme product form
    a = lg.index('      onOfferCta: (e) => {')
    b = lg.index('      hasUgc:', a)
    body = lg[a:b]
    body = sub1(body, "        if (!(e && e.currentTarget ? e.currentTarget : window).dispatchEvent(ev) && e) e.preventDefault();\n",
                "        if (e) e.preventDefault();\n"
                "        if (!(e && e.currentTarget ? e.currentTarget : window).dispatchEvent(ev)) return;\n"
                "        try { (window.dataLayer = window.dataLayer || []).push({ event: 'vetpets_add_to_cart', vetpets: detail }); } catch (x) {}\n"
                "        if (window.FWQK) { window.FWQK.addToCart(); this.setState({ kTick: Date.now() }); }\n", 'CTA dispatch')
    lg = lg[:a] + body + lg[b:]

    # keep Kaching in step with the picker, re-render on Kaching changes
    lg = sub1(lg, "  componentDidMount() {\n",
              "  _syncK() {\n"
              "    if (!window.FWQK) return;\n"
              "    const t = this.state.tier === 0 || this.state.tier === 1 ? this.state.tier : 1;\n"
              "    window.FWQK.select(t, !!this.state.routine);\n"
              "  }\n"
              "  componentDidMount() {\n"
              "    const hookK = () => { if (window.FWQK) { window.FWQK.onChange(() => this.setState({ kTick: Date.now() })); this._syncK(); this.setState({ kTick: Date.now() }); } else setTimeout(hookK, 50); };\n"
              "    hookK();\n", 'componentDidMount')
    lg = sub1(lg, "  componentDidUpdate(prevProps, prevState) {\n",
              "  componentDidUpdate(prevProps, prevState) {\n    this._syncK();\n", 'componentDidUpdate')

    head = (ROOT / 'scripts/freshwipes-quiz.head.liquid').read_text()
    foot = (ROOT / 'scripts/freshwipes-quiz.foot.liquid').read_text()
    out = (head
           + "{%- capture fwq_tpl -%}{% raw %}" + tpl + "{% endraw %}{%- endcapture -%}\n"
           + "{%- capture fwq_logic -%}{% raw %}" + lg + "{% endraw %}{%- endcapture -%}\n"
           + foot)
    if '{% endraw %}' in tpl or '{% endraw %}' in lg:
        sys.exit('build-freshwipes-quiz: raw block collision')
    OUT.write_text(out)
    print('wrote', OUT.relative_to(ROOT), len(out), 'bytes')


if __name__ == '__main__':
    main()
