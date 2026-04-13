# Interview assignment — Shopify collection grid

**Repository:** Dawn-based Shopify theme (`theme-clothing`)  
**Focus:** Custom collection product grid — featured ordering, infinite scroll, correct behaviour with filters and sorting.

This README is the **submission overview** for reviewers. Implementation details, state machine, and troubleshooting live in the **[technical appendix](./README-COLLECTION-INFINITE-SCROLL.md)**.

---

## 1. Problem statement (brief)

Build collection behaviour where:

- On **default** collection view: products tagged “featured” (configurable) appear first (up to **15**), then normal products to fill **20** on the first screen; **infinite scroll** loads additional **non-featured** products in batches of **20** without duplicates and without showing featured again in the stream.
- On **filtered or sorted** view: **do not** prioritise featured; match Shopify storefront behaviour; still support **infinite scroll** using the same rules as the filtered/sorted listing.
- Handle **large** collections efficiently; handle **edge cases** (no featured products, featured only on later “pages” of the default sort, etc.).

---

## 2. Solution summary

| Area | Approach |
|------|----------|
| **First paint (featured mode)** | Liquid splits handles from the first paginated window (max 50 products per Shopify limit), renders up to 15 featured + remainder to 20 non-featured using `all_products[handle]`. |
| **Reconcile & infinite (featured)** | JavaScript loads `/collections/{handle}/products.json` (paged by 250), recomputes ideal first 20 vs DOM, refetches card HTML via **Section Rendering** (`product.ajax-card` + `ajax-product-card` section) when needed, then maintains a queue of non-featured handles for scroll batches. |
| **Filtered / sorted + infinite** | Liquid detects active filters (including **price range** via `min_value` / `max_value`, not only `active_values`) and non-default sort; paginates by batch size; JS loads the **next page** via the same URL + query string + `section_id` as Dawn’s facet requests (Section Rendering API). |
| **Facet updates** | `FacetFiltersForm.renderProductGridContainer` is wrapped once to dispatch `collection:grid-updated`; scroll controllers destroy and remount from fresh DOM/config. |
| **Performance** | Throttled scroll (~150 ms); batched parallel fetches for card HTML (featured path); no redundant polling. |

---

## 3. Requirements checklist

| Requirement | Where it’s satisfied |
|-------------|----------------------|
| 100+ products, 15 featured | JSON pagination in JS; featured cap 15 in Liquid + JS. |
| Initial screen: 15 featured + 5 normal (= 20) | Liquid + `CollectionInfiniteScrollConfig` constants; JS queue excludes initial set. |
| Infinite scroll +20 non-featured | `infinite_scroll_batch` (default 20); featured-tagged products excluded from queue. |
| Sort/filter → default Shopify behaviour | `use_custom_featured_grid` is false when `filters_active` or `sort_is_non_default`; facet infinite uses server HTML. |
| No duplicates | `Set` of `data-product-id`; append only unseen IDs. |
| Large collections | `products.json` multi-page fetch; Liquid paginate 50 for featured split; facet mode uses native pagination pages. |
| No featured in infinite stream | Queue skips any product with featured tag; guard IDs on append. |
| Price filter correctness | Liquid marks `filters_active` for `price_range` when min/max set; JS skips unfiltered JSON hydration if URL contains `filter.`. |

---

## 4. Files delivered / touched

| Path | Role |
|------|------|
| `sections/main-collection-product-grid.liquid` | Mode detection, pagination sizes, featured split markup, facet infinite markup, JSON config, spinner/sentinel, script tag. |
| `assets/custom-infinite-scroll.js` | Featured controller, facet controller, facet patch, throttle, remount on `collection:grid-updated`. |
| `sections/ajax-product-card.liquid` | Single `<li>` + `card-product` for Section Rendering from product URL. |
| `templates/product.ajax-card.json` | Alternate product template for AJAX cards. |
| `README.md` | This submission overview. |
| `README-COLLECTION-INFINITE-SCROLL.md` | Deeper technical / maintenance notes. |

`snippets/card-product.liquid` was intentionally left unchanged; behaviour is driven by the `<li>` wrapper and section settings.

---

## 5. How to review (Shopify)

1. Push the theme to a **development store**
2. Use a collection with **many** products; tag **15** with the configured featured tag (default `featured`).
3. **Unfiltered, default sort:** confirm first row order (featured first), then scroll — only non-featured products append; no duplicates.
4. **Apply a list filter** (e.g. availability or option): confirm grid matches filter; scroll loads more with filter still applied.
5. **Apply price range only:** confirm products fall in range (this path depends on correct `price_range` detection in Liquid).
6. **Change sort** (e.g. price, A–Z): confirm featured pinning is off; infinite scroll still works if more than one page exists.
7. **Theme editor:** `Collection` template → **Product grid** section — toggle “Pin featured…”, “Infinite scroll when filters…”, batch size, and confirm behaviour matches expectations.

---

## 6. Design decisions & tradeoffs

- **Two data sources:** `products.json` cannot represent storefront filters on the collection URL, so featured reordering is **only** enabled when Liquid considers the view unfiltered and default-sorted. Filtered infinite scroll **must** use Section Rendering + `page` — there is no single JSON shortcut that preserves facet parity.
- **`all_products` in Liquid:** Resolves handles to product objects for cards after splitting; products must be available on the Online Store channel.
- **AJAX card template:** Appended rows in featured mode use `product.ajax-card` so markup matches `card-product`; **settings in `product.ajax-card.json` should be kept aligned** with the collection grid section or visuals may drift (documented tradeoff).

---

## 7. Known limitations & possible extensions

- More than **15** products share the featured tag: only the first 15 in collection order appear in the featured block; additional tagged products are excluded from the infinite stream by design.
- **16th+ “featured”** product is not shown unless the merchant changes rules — acceptable edge case for the stated “15 featured” spec.
- **Future work:** Section API returning a **fragment** of only new `<li>` nodes (if Shopify/theme supported a dedicated endpoint) would reduce payload vs full section HTML; GraphQL Storefront API could unify loading but increases scope and tokens.

---

 
