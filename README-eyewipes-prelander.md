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

That covers the offer-card CTA, the sticky-bar CTA and the "Product:" link on
each review card (8 links in total). Two buttons are in-page anchors instead:

| Button | Target |
|---|---|
| **"See Why It Works ↓"** (hero, 1×) | `#eyewipes-proof` — the "The proof is on the wipe" section |
| **"Skip to offer ↓"** (6×) | `#eyewipes-offer` — the offer block |

Both are plain `href` anchors, so they work with JavaScript disabled. They smooth
scroll via `html { scroll-behavior: smooth }` and fall back to an immediate jump
under `prefers-reduced-motion`. Neither carries `data-ewpl-pdp`, so advertising
parameters are never appended to an internal anchor.

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

## The rolling announcement bar

The ticker is a pure CSS transform animation with no JavaScript and no runtime
cloning.

The track holds exactly **two identical groups** and animates
`translate3d(0,0,0)` → `translate3d(-50%,0,0)`. Half the track is exactly one
group, so when the animation wraps, group two sits precisely where group one
started — no gap and no visible reset.

The one thing that has to be right is the group width. One pass of the four
claims measures ~1505px; if a group is narrower than the viewport, the tail of
the track exposes a blank strip on wide desktops (the original build left 23% of
a 1920px viewport and 42% of a 2560px viewport empty at the worst phase). Each
group therefore repeats the sequence **three times** (~4516px), which stays
wider than any viewport up to 4516px.

Two values must move together:

* `ewpl_mq_copies` in `sections/eyewipes-prelander.liquid` — copies rendered per group
* `--ewpl-mq-copies` in `assets/eyewipes-prelander.css` — multiplies `--ewpl-mq-sequence` (34s) to give the duration

Because the duration scales with the group, the scroll speed is pinned at the
design's ~44.3 px/s whatever the copy count is. Change one, change the other.

The groups are decorative duplicates and both carry `aria-hidden="true"`; the
four claims are exposed to assistive technology exactly once through a
visually-hidden list immediately above the track. `prefers-reduced-motion` stops
the animation and parks the track at its start, leaving a readable static row.

## Progressive enhancement

The page is fully readable with JavaScript disabled. Only four things are
enhancements:

* the countdown ticks (Liquid seeds it from shop time on render);
* the announcement ticker rolls (it renders as a static readable row without it);
* the mobile comparison tabs (all four panels are rendered server-side; the
  first is shown);
* the review-rail arrows (the rail is touch/trackpad scrollable regardless);
* attribution forwarding.

`prefers-reduced-motion` disables the marquee, the CTA hover transform and
smooth scrolling.

## Deliberate deviations from the design file

Three, all documented here:

1. **The proof section anchor is `#eyewipes-proof`.** The design file used
   `#why-eye-care`; the id was renamed so the hero anchor has a stable, named
   target. Nothing else referenced the old id.
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
