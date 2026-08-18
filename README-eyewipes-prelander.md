# EyeWipes pre-lander

Native theme build of the approved Claude Design page **"EyeWipes Pre-Lander v2"**
(Claude Design project *VetPets EyeWipes Pre-Lander*, file
`EyeWipes Pre-Lander v2.dc.html`).

The page renders with **no header, no navigation, no announcement bar and no
footer** — it uses its own layout.

## Files

```
templates/page.eyewipes-prelander.json   template; selects the dedicated layout
layout/eyewipes-prelander.liquid         standalone layout (no theme chrome)
sections/eyewipes-prelander.liquid       the whole page, top bar -> sticky CTA
snippets/ewpl-mark.liquid                one comparison-table cell marker
snippets/ewpl-review.liquid              one customer review card
assets/eyewipes-prelander.css            scoped stylesheet (see below)
assets/eyewipes-prelander.js             countdown, tabs, review rail, attribution
assets/ewpl-*.webp                       the design's images, losslessly re-encoded
assets/ewpl-geist-*.woff2                Geist 400/500/600/700/800, self-hosted
```

## Isolation

Everything lives under `id="eyewipes-prelander"`. Every component rule in the
stylesheet is prefixed with that id, the JavaScript only queries inside that
element and writes nothing to the global scope, and the layout is used by this
one template. Nothing here can reach another page of the storefront.

The layout deliberately does **not** load the theme's own CSS, so the page does
not inherit the Dawn `html { font-size: 62.5% }` scale. All values are px and
map 1:1 to the design.

## CTA routing

Every call to action opens the canonical PDP:

```
https://shopvetpets.com/products/eyewipes-prevention-that-keeps-eyes-clear
```

That covers the hero button, the offer-card CTA, the sticky-bar CTA and the
"Product:" link on each review card (9 links in total). The single exception is
**"Skip to offer"** (6 instances), which scrolls to `#eyewipes-offer` on this
same page.

The PDP link is overridable per page in the theme editor under **Call to
action → PDP link**. It is a `text` setting, not a `url` setting, because
Shopify rejects an absolute URL as the schema *default* of a `url` setting.

`assets/eyewipes-prelander.js` forwards advertising attribution from the
pre-lander URL onto every PDP link: any `utm_*` parameter plus `fbclid`,
`gclid`, `gbraid`, `wbraid`, `gad_source`, `gclsrc`, `msclkid`, `ttclid`,
`twclid`, `li_fat_id`, `epik`, `irclickid`, `rdt_cid`, `sccid`, `yclid`, and
`preview_theme_id` (so a tester stays inside the preview theme). Anything else
in the query string is dropped, and a parameter already present on the link is
never overwritten.

## Progressive enhancement

The page is fully readable with JavaScript disabled. Only four things are
enhancements:

* the countdown ticks (Liquid seeds it from shop time on render);
* the mobile comparison tabs (all four panels are rendered server-side; the
  first is shown);
* the review-rail arrows (the rail is touch/trackpad scrollable regardless);
* attribution forwarding.

`prefers-reduced-motion` disables the marquee, the CTA hover transform and
smooth scrolling.

## Deliberate deviations from the design file

Three, all forced and all documented here:

1. **"See Why It Works" points at the PDP.** In the design file it scrolled to
   `#why-eye-care`. The implementation brief lists it explicitly among the CTAs
   that must open the canonical PDP, and that rule was marked as overriding
   everything else. The `#why-eye-care` section id is still present.
2. **The offer CTA and the sticky CTA wrap below 900px.** The design sets
   `white-space: nowrap` on both. At 375px and 390px that pushes the document
   into horizontal scroll — the design preview does the same. The labels wrap on
   phones and are back on one line from 900px up, where the design intends it.
   The sticky label is also scaled down slightly under 900px so it stays on one
   line at normal phone widths.
3. **Sticky clearance is measured, not fixed.** The design reserves a flat
   104px at the bottom of the page. The JS sets `--ewpl-sticky-h` from the bar's
   real height instead, so the offer card is never covered.

Below 360px — outside the design's range — the offer ribbon and sticky headline
are allowed to wrap rather than overflow.

## Images

Every image is the exact asset from the design project. The CloudFront originals
were 4.6–7.5 MB PNGs; they are re-encoded to WebP at the size each slot actually
renders (652 KB for the whole page). No image was regenerated, retouched,
recoloured or recomposed. The guarantee photo is the version the designer
dropped into the slot, not the slot's fallback `src`.

`ewpl-offer-jar.webp` is byte-identical to the design file's copy.

## Shopify page

| | |
|---|---|
| Title | **EyeWipes Pre-Lander** |
| Handle | `eyewipes-prelander` |
| Template suffix | `eyewipes-prelander` |
| Dev theme | `vetpets-theme/dev`, id `181692858635` (unpublished, tracks the `dev` branch) |

Preview (Shopify admin login required while the page is a draft):

```
https://shopvetpets.com/pages/eyewipes-prelander?preview_theme_id=181692858635
```

Note: a separate, older page **"EyeWipes Pre-Lander v2"** (handle
`eyewipes2-pdp`, published) already carries the same `eyewipes-prelander`
template suffix. It was left untouched. Once this template reaches a theme, that
page will render this pre-lander too — decide whether that is wanted before
merging `dev` into `main`.

**To go live:** publish the page and merge `dev` into `main`. Until then the
live theme has no `eyewipes-prelander` template and the page falls back to the
default page template.
