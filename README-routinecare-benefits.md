# RoutineCare benefits page

Native theme build of the approved Claude Design page **"VetPets - RoutineCare Benefits Page (2026-10-15)"**
(project `f9387acf-40a4-437b-9dd2-6f02e03df41b`, file `RoutineCare Benefits Page.dc.html`). Intended URL: `/pages/routinecare`.

Unlike the pre-landers, this page uses the theme's **normal layout**, so the store header, announcement bar and
footer render around it as on any other page.

## Files

```
templates/page.routinecare.json        template (alternate page template "routinecare")
sections/routinecare-benefits.liquid   the whole page: hero -> trust band
assets/routinecare-benefits.css        scoped stylesheet
assets/rcb-*.webp                      the design's images (WebP, each under 150 KB)
```

Milestone reward images load from the same Shopify Files the subscription portal uses.

## Isolation

Everything lives under `id="routinecare-benefits"`. Every rule in the stylesheet is prefixed with that id and every
class with `rcb-`, so nothing here can reach another page. No JavaScript.

## Links (theme editor -> RoutineCare benefits)

| Setting | Default |
|---|---|
| Pet Health Profile link | `https://shopvetpets.whop.site/pet-health-profile` |
| FAQ link | `https://shopvetpets.com/pages/frequently-asked-questions-faq` |
| Contact link | `https://shopvetpets.com/pages/contact` |

## Preview and go-live

- Preview on this theme before a page exists: any page URL with `?view=routinecare&preview_theme_id=<theme id>`.
- Go-live: a Shopify page with handle `routinecare`, template `page.routinecare`, kept hidden until approved.
