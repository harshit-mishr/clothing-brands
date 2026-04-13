(function () {
  'use strict';

  const EVENT_GRID_UPDATED = 'collection:grid-updated';

  /**
   * @param {Function} fn
   * @param {number} waitMs
   */
  function throttle(fn, waitMs) {
    let last = 0;
    let trailingTimer = null;
    return function throttled(...args) {
      const now = Date.now();
      const remaining = waitMs - (now - last);
      if (remaining <= 0) {
        if (trailingTimer) {
          clearTimeout(trailingTimer);
          trailingTimer = null;
        }
        last = now;
        fn.apply(this, args);
      } else if (!trailingTimer) {
        trailingTimer = setTimeout(() => {
          trailingTimer = null;
          last = Date.now();
          fn.apply(this, args);
        }, remaining);
      }
    };
  }

  function patchFacetGridRenderer() {
    if (typeof FacetFiltersForm === 'undefined' || !FacetFiltersForm.renderProductGridContainer) return;
    if (FacetFiltersForm.renderProductGridContainer.__collectionScrollPatched) return;
    const original = FacetFiltersForm.renderProductGridContainer.bind(FacetFiltersForm);
    FacetFiltersForm.renderProductGridContainer = function patched(html) {
      original(html);
      document.dispatchEvent(new CustomEvent(EVENT_GRID_UPDATED));
    };
    FacetFiltersForm.renderProductGridContainer.__collectionScrollPatched = true;
  }

  /**
   * @param {string} tags
   * @param {string} featuredTag
   */
  function productHasFeaturedTag(tags, featuredTag) {
    if (!tags) return false;
    const needle = featuredTag.toLowerCase();
    if (Array.isArray(tags)) {
      return tags.some((t) => String(t).toLowerCase() === needle);
    }
    return String(tags)
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .includes(needle);
  }

  /**
   * @param {string} collectionHandle
   * @returns {Promise<object[]>}
   */
  async function fetchAllCollectionProducts(collectionHandle) {
    const limit = 250;
    let page = 1;
    /** @type {object[]} */
    const all = [];
    while (true) {
      const url = `/collections/${encodeURIComponent(collectionHandle)}/products.json?limit=${limit}&page=${page}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`products.json failed: ${res.status}`);
      const data = await res.json();
      const batch = data.products || [];
      if (!batch.length) break;
      all.push(...batch);
      if (batch.length < limit) break;
      page += 1;
    }
    return all;
  }

  /**
   * @param {string} handle
   * @param {string} view
   * @param {string} sectionId
   */
  async function fetchProductCardHtml(handle, view, sectionId) {
    const url = `/products/${encodeURIComponent(handle)}?view=${encodeURIComponent(view)}&section_id=${encodeURIComponent(sectionId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Card fetch failed for ${handle}: ${res.status}`);
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const li = doc.querySelector('li[data-product-handle], li.grid__item');
    return li ? li.outerHTML : null;
  }

  /**
   * @param {string[]} handles
   * @param {string} view
   * @param {string} sectionId
   * @param {number} concurrency
   */
  async function fetchProductCardsBatched(handles, view, sectionId, concurrency) {
    /** @type {string[]} */
    const htmlChunks = [];
    for (let i = 0; i < handles.length; i += concurrency) {
      const slice = handles.slice(i, i + concurrency);
      const results = await Promise.all(
        slice.map((h) =>
          fetchProductCardHtml(h, view, sectionId).catch(() => {
            return null;
          })
        )
      );
      for (const r of results) {
        if (r) htmlChunks.push(r);
      }
    }
    return htmlChunks.join('');
  }

  /**
   * @param {object[]} products
   * @param {string} featuredTag
   * @param {number} maxFeatured
   */
  function buildFeaturedAndRest(products, featuredTag, maxFeatured) {
    /** @type {object[]} */
    const featuredOrdered = [];
    /** @type {object[]} */
    const nonFeaturedOrdered = [];
    /** @type {Set<number>} */
    const featuredIds = new Set();

    for (const p of products) {
      if (productHasFeaturedTag(p.tags, featuredTag)) {
        featuredOrdered.push(p);
        featuredIds.add(p.id);
      } else {
        nonFeaturedOrdered.push(p);
      }
    }

    const topFeatured = featuredOrdered.slice(0, maxFeatured);

    /** Handles that must never load via infinite scroll */
    const neverInScrollIds = new Set(featuredIds);

    return {
      topFeatured,
      nonFeaturedOrdered,
      neverInScrollIds,
    };
  }

  class FeaturedFirstInfiniteScroll {
    constructor() {
      this.grid = null;
      this.config = null;
      this.sentinel = null;
      this.statusEl = null;
      this.spinner = null;
      this.queueHandles = [];
      this.neverScrollIds = new Set();
      this.renderedIds = new Set();
      this.loading = false;
      this.done = false;
      this.scrollHandler = null;
      this.hydrateGeneration = 0;
    }

    destroy() {
      this.detachScroll();
      this.hydrateGeneration += 1;
      this.grid = null;
      this.config = null;
      this.queueHandles = [];
      this.renderedIds.clear();
      this.neverScrollIds.clear();
      this.loading = false;
      this.done = false;
    }

    tryMount() {
      this.grid = document.querySelector('#product-grid[data-use-custom-infinite="true"]');
      if (!this.grid) return;

      const raw = document.getElementById('CollectionInfiniteScrollConfig');
      if (!raw || !raw.textContent) return;

      try {
        this.config = JSON.parse(raw.textContent);
      } catch (e) {
        console.error('[FeaturedFirstInfiniteScroll] Invalid config JSON', e);
        return;
      }

      if (this.config.mode === 'facet-section') return;

      this.sentinel = document.getElementById('CollectionInfiniteScrollSentinel');
      this.statusEl = document.getElementById('CollectionInfiniteScrollStatus');
      this.spinner = this.statusEl?.querySelector('.loading__spinner');

      this.bootstrapFromDom();
      void this.hydrateFromJson();
    }

    bootstrapFromDom() {
      this.renderedIds.clear();
      this.grid.querySelectorAll('[data-product-id]').forEach((el) => {
        const id = parseInt(el.getAttribute('data-product-id'), 10);
        if (!Number.isNaN(id)) this.renderedIds.add(id);
      });
    }

    async hydrateFromJson() {
      const gen = ++this.hydrateGeneration;
      // products.json ignores URL facets; never replace the grid when storefront filters are present.
      if (/[?&]filter\./.test(window.location.search)) {
        this.queueHandles = [];
        this.done = true;
        this.toggleSentinel(false);
        return;
      }
      const { collectionHandle, featuredTag, initialFeaturedMax, initialNormalCount, view, sectionId } = this.config;
      try {
        const products = await fetchAllCollectionProducts(collectionHandle);
        if (gen !== this.hydrateGeneration || !this.grid) return;

        const { topFeatured, nonFeaturedOrdered, neverInScrollIds } = buildFeaturedAndRest(
          products,
          featuredTag,
          initialFeaturedMax
        );
        this.neverScrollIds = neverInScrollIds;

        const firstHandles = [];
        for (const p of topFeatured) {
          firstHandles.push(p.handle);
        }
        for (const p of nonFeaturedOrdered) {
          if (firstHandles.length >= initialFeaturedMax + initialNormalCount) break;
          firstHandles.push(p.handle);
        }

        const firstIds = [];
        const handleToId = new Map();
        for (const p of products) {
          handleToId.set(p.handle, p.id);
        }
        for (const h of firstHandles) {
          const id = handleToId.get(h);
          if (id != null) firstIds.push(id);
        }

        const domOrder = Array.from(this.grid.querySelectorAll(':scope > li[data-product-id]')).map((li) =>
          parseInt(li.getAttribute('data-product-id'), 10)
        );
        const sameMultiset =
          firstIds.length === domOrder.length &&
          firstIds.every((id) => domOrder.includes(id)) &&
          domOrder.every((id) => firstIds.includes(id));
        const orderMatch = sameMultiset && firstIds.every((id, idx) => id === domOrder[idx]);

        if (!orderMatch) {
          await this.rebuildInitialGrid(firstHandles, view, sectionId);
          if (gen !== this.hydrateGeneration || !this.grid) return;
        }

        this.bootstrapFromDom();
        this.buildQueue(products, new Set(firstHandles), featuredTag);
        this.attachScroll();
      } catch (e) {
        console.error('[FeaturedFirstInfiniteScroll] hydrateFromJson', e);
      }
    }

    async rebuildInitialGrid(handlesInOrder, view, sectionId) {
      this.setLoading(true);
      const html = await fetchProductCardsBatched(handlesInOrder, view, sectionId, 6);
      this.grid.innerHTML = html;
      this.setLoading(false);
    }

    buildQueue(products, initialHandles, featuredTag) {
      /** @type {string[]} */
      const queue = [];
      for (const p of products) {
        if (initialHandles.has(p.handle)) continue;
        if (productHasFeaturedTag(p.tags, featuredTag)) continue;
        queue.push(p.handle);
      }
      this.queueHandles = queue;
      this.done = this.queueHandles.length === 0;
      this.toggleSentinel(!this.done);
    }

    attachScroll() {
      if (this.scrollHandler) return;
      this.scrollHandler = throttle(() => this.onScroll(), 150);
      window.addEventListener('scroll', this.scrollHandler, { passive: true });
    }

    detachScroll() {
      if (this.scrollHandler) {
        window.removeEventListener('scroll', this.scrollHandler);
        this.scrollHandler = null;
      }
    }

    onScroll() {
      if (!this.sentinel || this.loading || this.done) return;
      const rect = this.sentinel.getBoundingClientRect();
      if (rect.top < window.innerHeight + 400) {
        void this.loadNextBatch();
      }
    }

    async loadNextBatch() {
      if (this.loading || this.done || !this.config) return;
      const { batchSize, view, sectionId } = this.config;
      const batch = [];
      while (batch.length < batchSize && this.queueHandles.length) {
        const h = this.queueHandles.shift();
        batch.push(h);
      }
      if (!batch.length) {
        this.done = true;
        this.toggleSentinel(false);
        return;
      }

      this.loading = true;
      this.setLoading(true);
      try {
        const html = await fetchProductCardsBatched(batch, view, sectionId, 6);
        if (html) {
          const tpl = document.createElement('template');
          tpl.innerHTML = html;
          const nodes = tpl.content.querySelectorAll('li[data-product-id]');
          nodes.forEach((li) => {
            const id = parseInt(li.getAttribute('data-product-id'), 10);
            if (this.neverScrollIds.has(id)) return;
            if (this.renderedIds.has(id)) return;
            this.renderedIds.add(id);
            this.grid.appendChild(li);
          });
        }
      } catch (e) {
        console.error('[FeaturedFirstInfiniteScroll] loadNextBatch', e);
      } finally {
        this.loading = false;
        this.setLoading(false);
      }

      if (this.queueHandles.length === 0) {
        this.done = true;
        this.toggleSentinel(false);
      }
    }

    setLoading(on) {
      if (!this.spinner || !this.statusEl) return;
      this.spinner.classList.toggle('hidden', !on);
      this.statusEl.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    toggleSentinel(show) {
      if (this.sentinel) this.sentinel.hidden = !show;
    }
  }

  class FacetFilteredInfiniteScroll {
    constructor() {
      this.grid = null;
      this.config = null;
      this.sentinel = null;
      this.statusEl = null;
      this.spinner = null;
      this.nextPage = 2;
      this.totalPages = 1;
      this.sectionId = '';
      this.renderedIds = new Set();
      this.loading = false;
      this.done = false;
      this.scrollHandler = null;
    }

    destroy() {
      this.detachScroll();
      this.grid = null;
      this.config = null;
      this.nextPage = 2;
      this.totalPages = 1;
      this.renderedIds.clear();
      this.loading = false;
      this.done = false;
    }

    tryMount() {
      this.grid = document.querySelector('#product-grid[data-use-facet-infinite="true"]');
      if (!this.grid) return;

      const raw = document.getElementById('CollectionInfiniteScrollConfig');
      if (!raw || !raw.textContent) return;

      try {
        this.config = JSON.parse(raw.textContent);
      } catch (e) {
        console.error('[FacetFilteredInfiniteScroll] Invalid config JSON', e);
        return;
      }

      if (this.config.mode !== 'facet-section') return;

      this.sectionId = this.config.sectionId;
      this.totalPages = parseInt(this.config.totalPages, 10) || 1;
      this.nextPage = (parseInt(this.config.initialPage, 10) || 1) + 1;

      this.sentinel = document.getElementById('CollectionInfiniteScrollSentinel');
      this.statusEl = document.getElementById('CollectionInfiniteScrollStatus');
      this.spinner = this.statusEl?.querySelector('.loading__spinner');

      this.bootstrapFromDom();
      this.done = this.nextPage > this.totalPages;
      this.toggleSentinel(!this.done && this.totalPages > 1);
      this.attachScroll();
    }

    bootstrapFromDom() {
      this.renderedIds.clear();
      this.grid.querySelectorAll(':scope > li[data-product-id]').forEach((el) => {
        const id = parseInt(el.getAttribute('data-product-id'), 10);
        if (!Number.isNaN(id)) this.renderedIds.add(id);
      });
    }

    attachScroll() {
      if (this.scrollHandler) return;
      this.scrollHandler = throttle(() => this.onScroll(), 150);
      window.addEventListener('scroll', this.scrollHandler, { passive: true });
    }

    detachScroll() {
      if (this.scrollHandler) {
        window.removeEventListener('scroll', this.scrollHandler);
        this.scrollHandler = null;
      }
    }

    onScroll() {
      if (!this.sentinel || this.loading || this.done) return;
      const rect = this.sentinel.getBoundingClientRect();
      if (rect.top < window.innerHeight + 400) {
        void this.loadNextPage();
      }
    }

    buildSectionFetchUrl(page) {
      const params = new URLSearchParams(window.location.search);
      params.set('page', String(page));
      params.set('section_id', this.sectionId);
      return `${window.location.pathname}?${params.toString()}`;
    }

    async loadNextPage() {
      if (this.loading || this.done || !this.grid || !this.sectionId) return;
      if (this.nextPage > this.totalPages) {
        this.done = true;
        this.toggleSentinel(false);
        return;
      }

      this.loading = true;
      this.setLoading(true);
      try {
        const url = this.buildSectionFetchUrl(this.nextPage);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Section fetch failed: ${res.status}`);
        const text = await res.text();
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const newGrid = doc.getElementById('product-grid');
        if (!newGrid) {
          this.done = true;
          this.toggleSentinel(false);
          return;
        }

        const items = newGrid.querySelectorAll(':scope > li[data-product-id]');
        let appended = 0;
        items.forEach((li) => {
          const id = parseInt(li.getAttribute('data-product-id'), 10);
          if (Number.isNaN(id) || this.renderedIds.has(id)) return;
          this.renderedIds.add(id);
          this.grid.appendChild(document.importNode(li, true));
          appended += 1;
        });

        if (appended === 0) {
          this.done = true;
          this.toggleSentinel(false);
          return;
        }

        this.nextPage += 1;
        if (this.nextPage > this.totalPages) {
          this.done = true;
          this.toggleSentinel(false);
        }
      } catch (e) {
        console.error('[FacetFilteredInfiniteScroll] loadNextPage', e);
        this.done = true;
        this.toggleSentinel(false);
      } finally {
        this.loading = false;
        this.setLoading(false);
      }
    }

    setLoading(on) {
      if (!this.spinner || !this.statusEl) return;
      this.spinner.classList.toggle('hidden', !on);
      this.statusEl.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    toggleSentinel(show) {
      if (this.sentinel) this.sentinel.hidden = !show;
    }
  }

  const featuredScroll = new FeaturedFirstInfiniteScroll();
  const facetScroll = new FacetFilteredInfiniteScroll();

  function remountCollectionScroll() {
    featuredScroll.destroy();
    facetScroll.destroy();

    const gridFeatured = document.querySelector('#product-grid[data-use-custom-infinite="true"]');
    if (gridFeatured) {
      featuredScroll.tryMount();
      return;
    }

    const gridFacet = document.querySelector('#product-grid[data-use-facet-infinite="true"]');
    if (gridFacet) {
      facetScroll.tryMount();
    }
  }

  function handleGridUpdated() {
    featuredScroll.destroy();
    facetScroll.destroy();
    window.requestAnimationFrame(remountCollectionScroll);
  }

  function init() {
    patchFacetGridRenderer();
    document.removeEventListener(EVENT_GRID_UPDATED, handleGridUpdated);
    document.addEventListener(EVENT_GRID_UPDATED, handleGridUpdated);
    remountCollectionScroll();
  }

  window.CustomCollectionInfiniteScroll = {
    init: remountCollectionScroll,
  };

  document.addEventListener('DOMContentLoaded', init);
})();
