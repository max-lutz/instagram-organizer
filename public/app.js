// Frontend for Socials Organizer. Ports the settled redesign prototype
// (docs/reference/prototype/v0.1/redesign-prototype.html, issue #4) onto the
// real JSON API (src/api/*) -- same visual language and interactions, but
// backed by fetch() instead of in-memory arrays. No build tooling: this file
// is loaded directly as a <script> (see public/index.html).
(function () {
  'use strict';

  const PALETTE = ['#B5533C','#4C6B8A','#6B7A4F','#B8863B','#7A5670','#3D6E8F','#9C5B8C','#5E7A9A','#A6763C','#4A7C6B','#8C6B47','#6E5B8C'];

  // ---------------- pure helpers (unit-tested from Node, see test/frontend/helpers.test.js) ----------------

  // Mirrors the server's title-default heuristic (src/api/posts.js) so the UI can
  // show the derived title instantly, without waiting on a round trip.
  function firstSentence(text) {
    if (!text) return '';
    const m = text.match(/[^.!?]*[.!?]/);
    return (m ? m[0] : text).trim();
  }
  function parseInstagramLink(link) {
    const m = (link || '').match(/instagram\.com\/(p|reel|tv)\/([^/?]+)/i);
    if (!m) return null;
    return { type: m[1].toLowerCase(), code: m[2] };
  }
  // `state.view` is 'all' | 'unsorted' | 'collection:<id>' -- these two are the single
  // place that encodes/decodes the 'collection:<id>' shape, instead of repeating the
  // prefix check and slice(11) at every call site.
  function collectionIdFromView(view) {
    return view && view.indexOf('collection:') === 0 ? view.slice(11) : null;
  }
  function viewForCollection(id) { return 'collection:' + id; }
  // Builds the query string for GET /api/posts from the current view/search/sort
  // state -- the sidebar's per-view scoping and issue #5's search/sort contract.
  function buildPostsQuery(s) {
    const params = new URLSearchParams();
    if (s.view === 'unsorted') params.set('unassigned', 'true');
    else {
      const collectionId = collectionIdFromView(s.view);
      if (collectionId !== null) params.set('collection_id', collectionId);
    }
    if (s.search && s.search.trim()) params.set('search', s.search.trim());
    if (s.sort) params.set('sort', s.sort);
    return params.toString();
  }
  function sameId(a, b) { return String(a) === String(b); }
  const escapeHtml = (str) => (str || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, alpha) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${alpha})`; }
  function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Decodes the small set of HTML entities Meta's export actually uses (named +
  // numeric) and strips inner tags (e.g. <br>). Node has no DOM to lean on for this
  // (unlike docs/reference/prototype/v0.0/clipping-box.html's div/innerHTML trick),
  // so it's done manually -- which also keeps it pure and unit-testable from Node
  // like the rest of this section.
  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(str) {
    return str.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ref) => {
      if (ref[0] === '#') {
        const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        return Number.isNaN(code) ? whole : String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[ref] !== undefined ? NAMED_ENTITIES[ref] : whole;
    });
  }
  function decodeAndStrip(fragment) {
    if (!fragment) return '';
    return decodeEntities(fragment.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  }

  // Every field in the export sits in one of these two-cell rows, varying only
  // by label ("Nom", "Légende", "Nom de profil", ...).
  function labelRowPattern(label) {
    return new RegExp(`<td class="_a6_q">${label}<\\/td><td class="_2piu _a6_r">([\\s\\S]*?)<\\/td>`, 'g');
  }
  function extractRow(text, label) {
    const m = labelRowPattern(label).exec(text);
    return m ? decodeAndStrip(m[1]) : '';
  }

  // Finds the collection's own "Nom" row preceding its "Contenu multimédia"
  // heading at `pos` -- same landmark-row approach as the reference prototype.
  // Unlike extractRow, this wants the LAST "Nom" row in the window (the
  // collection's own), not the first, which could belong to an earlier post's
  // Propriétaire section still inside the 4000-char lookback.
  function collectionNameBefore(raw, pos) {
    const windowStart = Math.max(0, pos - 4000);
    const chunk = raw.slice(windowStart, pos);
    const re = labelRowPattern('Nom');
    let lastMatch = null;
    let m;
    while ((m = re.exec(chunk)) !== null) lastMatch = m;
    return lastMatch ? decodeAndStrip(lastMatch[1]) : '';
  }

  // Parses a Meta/Instagram "Download your information" saved-collections export.
  // The markup is deeply and inconsistently nested, so rather than walking the DOM
  // tree, we split on two kinds of landmark rows that reliably appear in a fixed
  // order: each collection's own "Contenu multimédia" heading, and each post's own
  // URL row within it (docs/reference/prototype/v0.0/clipping-box.html). Hashtags
  // aren't extracted -- Tags are never auto-populated from imports (map #10 notes).
  function parseInstagramExport(raw) {
    const collStarts = [];
    const collRe = /<h2[^>]*>Contenu multimédia<\/h2>/g;
    let cm;
    while ((cm = collRe.exec(raw)) !== null) collStarts.push(cm.index);

    const urlRe = /<td colspan="2" class="_a6_q">URL<div><a target="_blank" href="(https:\/\/www\.instagram\.com\/[^"]+)">/g;
    const urlMarks = [];
    let um;
    while ((um = urlRe.exec(raw)) !== null) urlMarks.push({ href: um[1], index: um.index });

    const results = [];
    let collIdx = -1;
    let collectionName = '';
    for (let i = 0; i < urlMarks.length; i++) {
      const pos = urlMarks[i].index;
      while (collIdx + 1 < collStarts.length && collStarts[collIdx + 1] <= pos) {
        collIdx++;
        collectionName = collectionNameBefore(raw, collStarts[collIdx]);
      }
      const start = pos;
      const end = i + 1 < urlMarks.length ? urlMarks[i + 1].index : raw.length;
      const slice = raw.slice(start, end);

      const description = extractRow(slice, 'Légende');

      let ownerName = '';
      let ownerUsername = '';
      const oSecM = slice.match(/<h2[^>]*>Propriétaire<\/h2>([\s\S]*?)(?:<h2|$)/);
      if (oSecM) {
        ownerName = extractRow(oSecM[1], 'Nom');
        ownerUsername = extractRow(oSecM[1], 'Nom de profil');
      }

      results.push({ link: urlMarks[i].href, description, ownerName, ownerUsername, collectionName });
    }
    return results;
  }

  // issue #31/#41's reimport diff, run as an extra step appended to
  // performImport. Direction (a): an export link matches a tombstone that
  // hasn't been dismissed (deleted in-app, still saved on Instagram).
  // Direction (b): a live instagram-import Post, not reimport_dismissed,
  // whose link fell out of this export (removed/un-saved on Instagram).
  // deletedPosts/existingPosts are the raw API rows (deleted_posts / posts),
  // and deletedPosts must be *every* tombstone (dismissed or not): a
  // dismissed one still has to keep its link out of performImport's normal
  // add loop -- "dismissed" means silently ignored forever, not eligible to
  // silently come back as brand new. Only the review screen itself (via
  // readdCandidates) drops dismissed tombstones.
  function computeReimportDiff(parsedPosts, existingPosts, deletedPosts) {
    const exportLinks = new Set(parsedPosts.map((p) => p.link));
    const tombstoneByLink = new Map(deletedPosts.map((d) => [d.link, d]));

    const readdCandidates = [];
    for (const post of parsedPosts) {
      const tombstone = tombstoneByLink.get(post.link);
      if (tombstone && !tombstone.dismissed) readdCandidates.push({ exportPost: post, tombstone });
    }

    const dropCandidates = existingPosts.filter(
      (p) => p.provenance === 'instagram-import' && !p.reimport_dismissed && !exportLinks.has(p.link)
    );

    return { readdCandidates, dropCandidates, tombstoneByLink };
  }

  function debounce(fn, delay) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // Merges rapid edits to the same record into one PATCH after `delay`ms of
  // quiet, instead of one request per keystroke. `flushNow` sends immediately
  // (used before navigating away, so an in-flight edit is never silently lost).
  function createFieldSaver(delay) {
    let pendingId = null;
    let pendingPatch = {};
    let timer = null;
    function doFlush(save) {
      if (pendingId === null) return Promise.resolve();
      const id = pendingId;
      const patch = pendingPatch;
      pendingId = null;
      pendingPatch = {};
      return Promise.resolve(save(id, patch)).catch((err) => showToast(err.message));
    }
    return {
      schedule(id, fields, save) {
        if (pendingId !== id) pendingPatch = {};
        pendingId = id;
        Object.assign(pendingPatch, fields);
        clearTimeout(timer);
        timer = setTimeout(() => doFlush(save), delay);
      },
      flushNow(save) {
        clearTimeout(timer);
        return doFlush(save);
      },
    };
  }

  // ---------------- API client ----------------
  async function apiFetch(path, options) {
    const res = await fetch(path, options);
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  const apiGet = (path) => apiFetch(path);
  const apiPost = (path, body) => apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const apiPatch = (path, body) => apiFetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const apiDelete = (path) => apiFetch(path, { method: 'DELETE' });

  // ---------------- data ----------------
  let collections = [];
  let sections = [];
  let tags = [];
  let posts = []; // the current view's server-filtered + server-sorted posts
  let stats = { total: 0, unassigned: 0 };
  let activePost = null; // full post object behind the open detail panel (null for 'new' or closed)

  let state = {
    view: 'all', // 'all' | 'unsorted' | 'collection:<id>'
    search: '',
    sort: 'saved-desc',
    editingCollectionColor: PALETTE[0],
    pendingConfirm: null,
    detailMode: null, // null | 'new' | <postId>
    collHeaderExpanded: false,
    colorPopoverFor: null, // collection id (string) whose color popover is open
    groupByTag: false,
    tagAdderOpen: false,
    tagQuery: '',
    tagEditingId: null, // tag id (string) whose rename/recolor popover is open
    collapsedSections: new Set(), // section ids (string) currently collapsed in the sidebar
    editingSectionId: null, // section id (string) being renamed via #sectionOverlay, null when creating
  };
  let newPostTitleManual = false;
  let newPostTagIds = [];
  // Holds the "Add a Post" form's in-progress values across re-renders (e.g. attaching a
  // tag before submitting) -- without this, renderDetailPanel had nothing but `null` to
  // read a not-yet-created post's fields from, and any re-render silently blanked the form.
  let newPostDraft = { link: '', title: '', description: '', note: '' };
  let collDeleteTargetId = null;

  const postSaver = createFieldSaver(500);
  const collectionSaver = createFieldSaver(500);
  const tagSaver = createFieldSaver(500);

  async function savePostFields(id, patch) {
    const updated = await apiPatch(`/api/posts/${id}`, patch);
    // Unlike saveCollectionFields/saveTagFields, this was only ever updating
    // activePost -- the `posts` array entry stayed stale, so switching to a
    // different Post and back within the same view (openPostDetail reads
    // straight from `posts`, no reload) re-showed the pre-edit Post Note.
    const idx = posts.findIndex((p) => sameId(p.id, id));
    if (idx > -1) posts[idx] = updated;
    if (activePost && sameId(activePost.id, id)) {
      activePost = updated;
      const dTitleEl = $('#d-title');
      if (dTitleEl && document.activeElement !== dTitleEl) dTitleEl.value = updated.title || '';
      patchCardTitle(updated);
      patchCardDesc(updated);
    }
  }
  async function saveCollectionFields(id, patch) {
    const updated = await apiPatch(`/api/collections/${id}`, patch);
    const idx = collections.findIndex((c) => sameId(c.id, id));
    if (idx > -1) collections[idx] = updated;
  }
  async function saveTagFields(id, patch) {
    const updated = await apiPatch(`/api/tags/${id}`, patch);
    const idx = tags.findIndex((t) => sameId(t.id, id));
    if (idx > -1) tags[idx] = updated;
  }
  function flushAllSavers() {
    return Promise.all([
      postSaver.flushNow(savePostFields),
      collectionSaver.flushNow(saveCollectionFields),
      tagSaver.flushNow(saveTagFields),
    ]);
  }

  async function loadCollections() { collections = await apiGet('/api/collections'); }
  async function loadSections() { sections = await apiGet('/api/sections'); }
  async function loadTags() { tags = await apiGet('/api/tags'); }
  async function loadStats() { stats = await apiGet('/api/posts/stats'); }
  async function loadPosts() { posts = await apiGet('/api/posts?' + buildPostsQuery(state)); }
  async function refreshAfterMutation() {
    await Promise.all([loadCollections(), loadSections(), loadStats(), loadPosts()]);
    render();
  }

  const $ = (sel) => document.querySelector(sel);

  function getCollection(id) {
    if (id === null || id === undefined || id === '') return null;
    return collections.find((c) => sameId(c.id, id)) || null;
  }
  function getSection(id) {
    if (id === null || id === undefined || id === '') return null;
    return sections.find((s) => sameId(s.id, id)) || null;
  }
  function getTag(id) { return tags.find((t) => sameId(t.id, id)) || null; }
  function currentTagIds() {
    if (state.detailMode === 'new') return newPostTagIds;
    return activePost ? (activePost.tags || []).map((t) => t.id) : [];
  }
  // Which collection the open detail panel's tag picker should group by. For an
  // existing post this is its own collection; for a new, unsaved post there's no
  // activePost yet, so fall back to whatever's currently picked in the Collection
  // <select> (same source submitDetail() reads from, see collection_id below).
  function currentDetailCollectionId() {
    if (state.detailMode === 'new') {
      const el = document.getElementById('d-collection');
      return el ? (el.value || null) : collectionIdFromView(state.view);
    }
    return activePost ? (activePost.collection_id ?? null) : null;
  }
  // Tag ids used by at least one other Post in the given collection, derived from
  // the in-memory `posts` array (scoped to the current view -- see buildPostsQuery).
  function tagIdsUsedInCollection(collectionId) {
    const ids = new Set();
    if (collectionId === null || collectionId === undefined || collectionId === '') return ids;
    posts.forEach((p) => {
      if (sameId(p.collection_id, collectionId)) (p.tags || []).forEach((t) => ids.add(String(t.id)));
    });
    return ids;
  }
  function isVideoLink(link) { return /instagram\.com\/(reel|tv)\//i.test(link || ''); }

  function viewTitle() {
    if (state.view === 'unsorted') return 'To sort';
    const collectionId = collectionIdFromView(state.view);
    if (collectionId !== null) return getCollection(collectionId)?.name || 'Collection';
    return 'All posts';
  }
  function currentViewCount() {
    if (state.view === 'unsorted') return stats.unassigned;
    const collectionId = collectionIdFromView(state.view);
    if (collectionId !== null) return getCollection(collectionId)?.post_count ?? 0;
    return stats.total;
  }

  function showToast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.remove('show'), 5000);
  }
  function stubToast() { showToast('Coming soon'); }

  function dataMenuHtml() {
    return `
      <details class="menu" id="dataMenu">
        <summary class="btn-ghost">Data ▾</summary>
        <div class="menu-panel">
          <button type="button" id="importFileBtn">Import export file…</button>
          <button type="button" id="downloadBackupBtn">Download backup (JSON)</button>
          <button type="button" id="restoreBackupBtn">Restore from backup…</button>
        </div>
      </details>`;
  }
  function sortSelectHtml() {
    const options = [
      ['saved-desc', 'Newest saved'],
      ['saved-asc', 'Oldest saved'],
      ['modified-desc', 'Newest modification'],
      ['modified-asc', 'Oldest modification'],
      ['title-asc', 'A–Z (title)'],
    ];
    return `<select class="sort" id="sortSelect">${options.map(([value, label]) => `<option value="${value}" ${state.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  }

  // A Collection with no Section sits in the unlabeled bucket above all
  // Sections (decision on #28) -- easiest to find, since it's where a
  // freshly-created Collection always starts out.
  function isUngrouped(c) { return c.section_id === null || c.section_id === undefined; }

  function collectionNavItemHtml(c) {
    const active = state.view === viewForCollection(c.id);
    const style = `border-left:3px solid ${c.color};` + (active ? `background:${rgba(c.color, 0.14)}; color:${c.color};` : '');
    return `<button class="va-nav-item ${active ? 'active' : ''}" data-view="collection:${c.id}" style="${style}">
      <span class="va-dot" style="background:${c.color}"></span><span class="nav-name">${escapeHtml(c.name)}</span> <span class="count">${c.post_count}</span>
    </button>`;
  }

  // Collapsible Section group (decision on #28: Sections don't nest further,
  // so this is the only level of grouping above the flat Collection list).
  function sectionGroupHtml(s) {
    const collapsed = state.collapsedSections.has(String(s.id));
    const members = collections.filter((c) => sameId(c.section_id, s.id));
    return `
      <div class="va-section">
        <div class="va-section-header">
          <button type="button" class="va-section-toggle" data-action="toggle-section" data-id="${s.id}">
            <span class="va-caret">${collapsed ? '▸' : '▾'}</span><span class="va-section-name">${escapeHtml(s.name)}</span>
            <span class="count">${members.length}</span>
          </button>
          <span class="va-section-actions">
            <button type="button" class="icon-btn va-section-icon" data-action="rename-section" data-id="${s.id}" title="Rename section">✎</button>
            <button type="button" class="icon-btn va-section-icon" data-action="delete-section" data-id="${s.id}" title="Delete section">×</button>
          </span>
        </div>
        ${collapsed ? '' : `<div class="va-nav va-section-items">${members.map(collectionNavItemHtml).join('')}</div>`}
      </div>`;
  }

  function renderShell() {
    const ungrouped = collections.filter(isUngrouped);
    const nav = `
      <div class="va-sidebar">
        <div class="va-brand">Socials Organizer</div>
        <button class="btn-ghost va-newcoll" id="newCollBtn">+ New collection</button>
        <button class="btn-ghost va-newcoll" id="newSectionBtn">+ New section</button>
        <div class="va-nav">
          <button class="va-nav-item ${state.view === 'all' ? 'active' : ''}" data-view="all">All posts <span class="count">${stats.total}</span></button>
          <button class="va-nav-item ${state.view === 'unsorted' ? 'active' : ''}" data-view="unsorted">To sort <span class="count">${stats.unassigned}</span></button>
        </div>
        <div>
          <div class="va-nav-label">Collections</div>
          <div class="va-nav">
            ${ungrouped.map(collectionNavItemHtml).join('')}
          </div>
          ${sections.map(sectionGroupHtml).join('')}
        </div>
      </div>`;

    const topbar = `
      <div class="va-topbar">
        <input type="text" class="search" id="searchInput" placeholder="Search title, description, notes…" value="${escapeHtml(state.search)}">
        ${sortSelectHtml()}
        <div class="spacer"></div>
        <button class="btn-ghost ${state.groupByTag ? 'active' : ''}" id="groupByTagBtn">Group by tag</button>
        ${dataMenuHtml()}
        <button class="btn-primary" id="addPostBtn">+ Add a link</button>
      </div>`;

    const detailOpen = state.detailMode !== null;

    let headerBlock = '';
    let collHeaderBlock = '';
    const headerCollectionId = collectionIdFromView(state.view);
    if (headerCollectionId !== null) {
      const c = getCollection(headerCollectionId);
      if (c) {
        collHeaderBlock = (detailOpen && !state.collHeaderExpanded)
          ? `<button type="button" class="va-collheader-compact" id="collHeaderExpandBtn" style="border-left:4px solid ${c.color}" title="Show Collection Note">
               <span class="va-dot" style="background:${c.color}"></span>
               <span class="name">${escapeHtml(c.name) || '(untitled)'}</span>
               <span class="chevron">▾</span>
             </button>`
          : `<div class="va-collheader" style="border-top:4px solid ${c.color}">
               <div class="va-collheader-actions">
                 ${detailOpen ? `<button type="button" class="icon-btn" id="collHeaderCollapseBtn" title="Collapse">▴</button>` : ''}
                 <button type="button" class="btn-ghost" id="collDeleteBtn" data-id="${c.id}" style="color:var(--danger); border-color:var(--danger);" title="Delete this collection">Delete</button>
               </div>
               <div class="swatch-wrap">
                 <button type="button" class="swatch-btn" data-action="color-swatch" data-id="${c.id}" style="background:${c.color}" title="Change color"></button>
                 ${state.colorPopoverFor === String(c.id) ? colorPopoverHtml(c) : ''}
               </div>
               <div style="flex:1; min-width:0; padding-right:110px;">
                 <input type="text" id="coll-name-input" data-id="${c.id}" class="name-input" value="${escapeHtml(c.name)}" placeholder="Collection name">
                 <select id="coll-section-select" data-id="${c.id}" class="coll-section-select" title="Section">
                   <option value="">No section</option>
                   ${sections.map((s) => `<option value="${s.id}" ${sameId(c.section_id, s.id) ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
                 </select>
                 <textarea id="coll-note-input" data-id="${c.id}" class="note-input-inline" placeholder="Add a Collection Note — what's this collection for?">${escapeHtml(c.note || '')}</textarea>
               </div>
             </div>`;
      }
    } else {
      headerBlock = `<div class="va-heading"><h1>${viewTitle()}</h1><span class="count">${currentViewCount()} posts</span></div>`;
    }

    const list = posts;
    const grid = !list.length
      ? emptyBlock()
      : state.groupByTag
        ? renderGroupedByTag(list)
        : `<div class="va-grid">${list.map(renderPostCard).join('')}</div>`;
    const topBlock = `<div class="va-sticky-top">${topbar}${headerBlock}</div>`;
    const gridArea = detailOpen
      ? `<div class="va-content-row">${renderDetailPanel()}<div class="va-grid-wrap">${grid}</div></div>`
      : grid;

    return `<div class="va-shell">${nav}<div class="va-main">${topBlock}${collHeaderBlock}${gridArea}</div></div>`;
  }

  function renderGroupedByTag(list) {
    const groups = new Map(); // '__untagged__' | tagId -> posts[]
    const tagById = new Map();
    list.forEach((p) => {
      const postTags = p.tags || [];
      postTags.forEach((t) => tagById.set(String(t.id), t));
      if (postTags.length === 0) {
        if (!groups.has('__untagged__')) groups.set('__untagged__', []);
        groups.get('__untagged__').push(p);
      } else {
        postTags.forEach((t) => {
          const key = String(t.id);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(p);
        });
      }
    });
    const orderedKeys = [...groups.keys()].sort((a, b) => {
      if (a === '__untagged__') return -1;
      if (b === '__untagged__') return 1;
      return (tagById.get(a)?.name || '').localeCompare(tagById.get(b)?.name || '');
    });
    return orderedKeys.map((key) => {
      const groupPosts = groups.get(key);
      const heading = key === '__untagged__'
        ? `No tags <span class="count">${groupPosts.length}</span>`
        : `<span class="va-dot" style="background:${tagById.get(key).color}"></span>${escapeHtml(tagById.get(key).name)} <span class="count">${groupPosts.length}</span>`;
      return `<div class="va-group"><div class="va-group-heading">${heading}</div><div class="va-grid">${groupPosts.map(renderPostCard).join('')}</div></div>`;
    }).join('');
  }

  function colorPopoverHtml(c) {
    return `<div class="color-popover" id="colorPopover">
      <div class="swatch-picker">${PALETTE.map((hex) => `<button type="button" data-action="pick-color" data-id="${c.id}" data-color="${hex}" style="background:${hex}" class="${c.color === hex ? 'selected' : ''}"></button>`).join('')}</div>
    </div>`;
  }

  function tagRowHtml() {
    const ids = currentTagIds();
    const attached = ids.map((id) => getTag(id)).filter(Boolean);
    const pills = attached.map((t) => `
      <span class="tag-pill" style="background:${rgba(t.color, 0.16)}; color:${t.color}; border-color:${rgba(t.color, 0.4)}; position:relative;">
        <button type="button" class="tag-pill-name" data-action="edit-tag" data-tagid="${t.id}">${escapeHtml(t.name)}</button>
        <button type="button" class="tag-pill-x" data-action="remove-tag" data-tagid="${t.id}" title="Remove tag">✕</button>
        ${String(state.tagEditingId) === String(t.id) ? tagEditPopoverHtml(t) : ''}
      </span>`).join('');
    const adder = attached.length < 4
      ? `<span style="position:relative; display:inline-flex;">
           <button type="button" class="tag-pill tag-pill-add" id="tagAddBtn">+ Add tag</button>
           ${state.tagAdderOpen ? tagAdderPopoverHtml() : ''}
         </span>`
      : '';
    return `<div class="tag-row">${pills}${adder}</div>`;
  }
  function tagAdderPopoverHtml() {
    const q = state.tagQuery.trim().toLowerCase();
    const currentIds = currentTagIds().map(String);
    const matches = tags.filter((t) => currentIds.indexOf(String(t.id)) === -1 && t.name.toLowerCase().includes(q));
    const usedIds = tagIdsUsedInCollection(currentDetailCollectionId());
    const usedInCollection = matches.filter((t) => usedIds.has(String(t.id)));
    const others = matches.filter((t) => !usedIds.has(String(t.id)));
    const exact = tags.some((t) => t.name.toLowerCase() === q);
    const optionHtml = (t) => `<button type="button" class="tag-option" data-action="attach-tag" data-tagid="${t.id}"><span class="va-dot" style="background:${t.color}"></span>${escapeHtml(t.name)}</button>`;
    const optionsHtml = usedInCollection.length
      ? `<div class="tag-option-group-label">Used in this collection</div>${usedInCollection.map(optionHtml).join('')}${others.length ? `<div class="tag-option-group-label">Other tags</div>` : ''}${others.map(optionHtml).join('')}`
      : matches.map(optionHtml).join('');
    return `
      <div class="tag-popover" id="tagPopover">
        <input type="text" id="tagSearchInput" placeholder="Search or create a tag…" value="${escapeHtml(state.tagQuery)}" autocomplete="off">
        <div class="tag-options">
          ${optionsHtml}
          ${(!exact && q) ? `<button type="button" class="tag-option tag-option-create" data-action="create-tag">Create "${escapeHtml(state.tagQuery.trim())}"</button>` : ''}
          ${(!matches.length && !q) ? `<div class="tag-empty">Type to search or create a tag</div>` : ''}
        </div>
      </div>`;
  }
  function tagEditPopoverHtml(t) {
    if (!t) return '';
    return `
      <div class="tag-popover" id="tagEditPopover">
        <input type="text" id="tagRenameInput" data-tagid="${t.id}" value="${escapeHtml(t.name)}" autocomplete="off">
        <div class="swatch-picker">${PALETTE.map((hex) => `<button type="button" data-action="pick-tag-color" data-tagid="${t.id}" data-color="${hex}" style="background:${hex}" class="${t.color === hex ? 'selected' : ''}"></button>`).join('')}</div>
      </div>`;
  }

  function renderPostCard(p) {
    const c = getCollection(p.collection_id);
    const chip = c ? `<span class="va-coll-chip" style="color:${c.color}"><span class="va-dot" style="background:${c.color}"></span>${escapeHtml(c.name)}</span>` : `<span class="va-coll-chip" style="color:var(--text-faint)">To sort</span>`;
    const noteFlag = (p.note && p.note.trim()) ? `<span class="va-note-flag" title="Has a Post Note">📝</span>` : '';
    const titleHtml = p.title ? `<div class="post-title">${escapeHtml(p.title)}</div>` : `<div class="post-title note-placeholder">Untitled</div>`;
    const descHtml = p.description ? `<div class="post-desc">${escapeHtml(p.description)}</div>` : `<div class="post-desc note-placeholder">No description yet.</div>`;
    const topBorder = c ? `border-top:4px solid ${c.color};` : '';
    const selected = state.detailMode !== null && sameId(state.detailMode, p.id) ? 'selected' : '';
    return `
      <div class="va-card ${!p.collection_id ? 'unsorted' : ''} ${selected}" draggable="true" data-id="${p.id}" style="${topBorder}">
        <div class="va-card-top">
          <span class="va-card-top-left">${chip}${noteFlag}</span>
          <button class="icon-btn" data-action="delete" data-id="${p.id}" title="Delete">✕</button>
        </div>
        <div class="post-textblock">${titleHtml}${descHtml}</div>
        <div class="va-card-bottom">
          <a href="${escapeHtml(p.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open ↗</a>
          <span>${formatDate(p.created_at)}</span>
        </div>
      </div>`;
  }

  function renderDetailPanel() {
    const isNew = state.detailMode === 'new';
    const p = isNew ? null : activePost;
    if (!isNew && !p) return '';
    const collOptions = `<option value="">No collection (To sort)</option>` + collections.map((c) => {
      const preselect = isNew
        ? collectionIdFromView(state.view) === String(c.id)
        : sameId(p.collection_id, c.id);
      return `<option value="${c.id}" ${preselect ? 'selected' : ''}>${escapeHtml(c.name)}</option>`;
    }).join('');
    const linkVal = p ? p.link : newPostDraft.link;
    const titleVal = p ? (p.title || '') : newPostDraft.title;
    const descVal = p ? (p.description || '') : newPostDraft.description;
    const noteVal = p ? (p.note || '') : newPostDraft.note;
    const parsed = linkVal ? parseInstagramLink(linkVal) : null;
    const media = parsed
      ? `<div class="va-detail-media">
           <iframe src="https://www.instagram.com/${parsed.type === 'tv' ? 'tv' : parsed.type}/${parsed.code}/embed" loading="lazy" allowfullscreen scrolling="no"></iframe>
           <a class="btn-text" href="${escapeHtml(linkVal)}" target="_blank" rel="noopener">Open on Instagram ↗</a>
         </div>`
      : '';
    const actions = isNew
      ? `<div class="modal-actions">
           <button type="button" class="btn-ghost" id="detailCancelNew">Cancel</button>
           <button type="button" class="btn-primary" id="detailSubmitNew">Add Post</button>
         </div>`
      : `<div class="modal-actions" style="justify-content:space-between;">
           <button type="button" class="btn-ghost" id="detailDelete" style="color:var(--danger); border-color:var(--danger);">Delete</button>
           <button type="button" class="btn-primary" id="detailDone">Done</button>
         </div>`;
    const linkRow = isNew
      ? `<div class="field">
           <label for="d-link">Link</label>
           <input type="url" id="d-link" value="${escapeHtml(linkVal)}" placeholder="https://instagram.com/p/…">
         </div>`
      : '';
    const titleCollectionRow = `
      <div class="va-detail-row">
        <div class="field field-title">
          <label for="d-title">Title</label>
          <input type="text" id="d-title" value="${escapeHtml(titleVal)}" placeholder="First sentence of the description, or your own title">
        </div>
        <div class="field field-collection">
          <label for="d-collection">Collection</label>
          <select id="d-collection">${collOptions}</select>
        </div>
      </div>`;
    return `
      <div class="va-detail" id="detailPanel">
        <button class="icon-btn va-detail-close" id="detailClose" title="Close">✕</button>
        <div class="va-detail-scroll">
          <div class="va-detail-body">
            <div class="va-detail-left">
              <h2>${isNew ? 'Add a Post' : 'Edit Post'}</h2>
              ${media}
            </div>
            <div class="va-detail-fields">
              ${linkRow}
              ${tagRowHtml()}
              ${titleCollectionRow}
              <div class="va-detail-textareas">
                <div class="field field-note">
                  <label for="d-description">Description — the post's caption on Instagram</label>
                  <textarea id="d-description" class="note-input" placeholder="Paste or edit the caption/legend for this post">${escapeHtml(descVal)}</textarea>
                </div>
                <div class="field field-note">
                  <label for="d-post-note">Post Note — your own private note</label>
                  <textarea id="d-post-note" class="note-input" placeholder="Why did you save this? (optional)">${escapeHtml(noteVal)}</textarea>
                </div>
              </div>
            </div>
          </div>
        </div>
        ${actions}
      </div>`;
  }

  function emptyBlock() {
    return `<div class="empty"><h2>Nothing here</h2><p>Try a different search, or add a link to get started.</p></div>`;
  }

  // ---------------- render dispatch + handlers ----------------
  function render() {
    const app = $('#app');
    app.innerHTML = renderShell();
    attachHandlers();
    syncDetailPanelStickyOffset();
  }
  function syncDetailPanelStickyOffset() {
    const topBlock = document.querySelector('.va-sticky-top');
    const detail = document.querySelector('.va-detail');
    if (!topBlock || !detail) return;
    const collHeader = document.querySelector('.va-collheader, .va-collheader-compact');
    const collHeaderHeight = collHeader ? collHeader.offsetHeight + 22 : 0;
    const top = topBlock.offsetHeight + 18;
    detail.style.top = top + 'px';
    detail.style.maxHeight = `calc(100vh - ${top + collHeaderHeight + 20}px)`;
  }

  const debouncedSearch = debounce(async (value, caret) => {
    state.search = value;
    await loadPosts();
    render();
    const el = $('#searchInput');
    if (el) { el.focus(); el.setSelectionRange(caret, caret); }
  }, 300);

  // The embed preview (renderDetailPanel's `media` block) only reads the link at render
  // time, so typing/pasting into the Link field needs a render to actually refresh it.
  const debouncedLinkPreview = debounce((caret) => {
    render();
    const el = $('#d-link');
    if (el) { el.focus(); el.setSelectionRange(caret, caret); }
  }, 400);

  function attachHandlers() {
    const app = $('#app');

    app.querySelectorAll('[data-view]').forEach((el) => {
      el.addEventListener('click', async () => {
        await closeDetailPanel();
        state.view = el.dataset.view;
        await loadPosts();
        render();
      });
    });

    const searchInput = $('#searchInput');
    if (searchInput) searchInput.addEventListener('input', (e) => debouncedSearch(e.target.value, e.target.selectionStart));

    const sortSelect = $('#sortSelect');
    if (sortSelect) sortSelect.addEventListener('change', async (e) => {
      state.sort = e.target.value;
      await loadPosts();
      render();
    });

    app.querySelectorAll('.va-card').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="delete"]') || e.target.closest('a')) return;
        openPostDetail(el.dataset.id);
      });
    });
    app.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        confirmAction('Delete this post?', 'This removes it for good.', async () => {
          try {
            await apiDelete(`/api/posts/${id}`);
            if (state.detailMode !== null && sameId(state.detailMode, id)) await closeDetailPanel();
            await refreshAfterMutation();
          } catch (err) {
            showToast(err.message);
          }
        });
      });
    });

    const addPostBtn = $('#addPostBtn'); if (addPostBtn) addPostBtn.addEventListener('click', () => openPostNew());
    const newCollBtn = $('#newCollBtn'); if (newCollBtn) newCollBtn.addEventListener('click', () => openCollectionModal());
    const newSectionBtn = $('#newSectionBtn'); if (newSectionBtn) newSectionBtn.addEventListener('click', () => openSectionModal());
    app.querySelectorAll('[data-stub]').forEach((btn) => btn.addEventListener('click', () => { closeAllMenus(); stubToast(); }));
    const importFileBtn = $('#importFileBtn');
    if (importFileBtn) importFileBtn.addEventListener('click', () => { closeAllMenus(); $('#importFileInput').click(); });
    const downloadBackupBtn = $('#downloadBackupBtn');
    if (downloadBackupBtn) downloadBackupBtn.addEventListener('click', () => { closeAllMenus(); performDownloadBackup(); });
    const restoreBackupBtn = $('#restoreBackupBtn');
    if (restoreBackupBtn) restoreBackupBtn.addEventListener('click', () => { closeAllMenus(); $('#restoreFileInput').click(); });

    attachDetailHandlers();
  }
  function closeAllMenus() { document.querySelectorAll('details.menu[open]').forEach((d) => d.removeAttribute('open')); }

  // ---------------- inline collection editing, color popover, detail panel, drag & drop, tags ----------------
  function attachDetailHandlers() {
    const app = $('#app');

    const collHeaderExpandBtn = $('#collHeaderExpandBtn');
    if (collHeaderExpandBtn) collHeaderExpandBtn.addEventListener('click', () => { state.collHeaderExpanded = true; render(); });
    const collHeaderCollapseBtn = $('#collHeaderCollapseBtn');
    if (collHeaderCollapseBtn) collHeaderCollapseBtn.addEventListener('click', () => { state.collHeaderExpanded = false; render(); });
    const collDeleteBtn = $('#collDeleteBtn');
    if (collDeleteBtn) collDeleteBtn.addEventListener('click', (e) => { e.stopPropagation(); openCollDeleteModal(collDeleteBtn.dataset.id); });

    const nameInput = $('#coll-name-input');
    if (nameInput) nameInput.addEventListener('input', (e) => {
      const c = getCollection(nameInput.dataset.id);
      if (!c) return;
      c.name = e.target.value;
      const navName = document.querySelector(`.va-nav-item[data-view="collection:${c.id}"] .nav-name`);
      if (navName) navName.textContent = c.name || '(untitled)';
      collectionSaver.schedule(c.id, { name: e.target.value }, saveCollectionFields);
    });
    const noteInput = $('#coll-note-input');
    if (noteInput) noteInput.addEventListener('input', (e) => {
      const c = getCollection(noteInput.dataset.id);
      if (!c) return;
      c.note = e.target.value;
      collectionSaver.schedule(c.id, { note: e.target.value }, saveCollectionFields);
    });
    const sectionSelect = $('#coll-section-select');
    if (sectionSelect) sectionSelect.addEventListener('change', async (e) => {
      const id = sectionSelect.dataset.id;
      const value = e.target.value;
      try {
        const updated = await apiPatch(`/api/collections/${id}`, { section_id: value ? Number(value) : null });
        const idx = collections.findIndex((x) => sameId(x.id, id));
        if (idx > -1) collections[idx] = updated;
        render();
      } catch (err) { showToast(err.message); }
    });

    app.querySelectorAll('[data-action="toggle-section"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = String(btn.dataset.id);
        if (state.collapsedSections.has(id)) state.collapsedSections.delete(id);
        else state.collapsedSections.add(id);
        render();
      });
    });
    app.querySelectorAll('[data-action="rename-section"]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); openSectionModal(btn.dataset.id); });
    });
    app.querySelectorAll('[data-action="delete-section"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = getSection(btn.dataset.id);
        if (!s) return;
        confirmAction(
          'Delete this section?',
          `Its Collections move back to ungrouped — nothing else is deleted.`,
          async () => {
            try {
              await apiDelete(`/api/sections/${s.id}`);
              await refreshAfterMutation();
              showToast('Section deleted');
            } catch (err) { showToast(err.message); }
          }
        );
      });
    });

    app.querySelectorAll('[data-action="color-swatch"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.colorPopoverFor = state.colorPopoverFor === btn.dataset.id ? null : btn.dataset.id;
        render();
        if (state.colorPopoverFor) {
          setTimeout(() => document.addEventListener('click', handleOutsideColorPopoverClick, { once: true }), 0);
        }
      });
    });
    app.querySelectorAll('[data-action="pick-color"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const color = btn.dataset.color;
        state.colorPopoverFor = null;
        render();
        try {
          const updated = await apiPatch(`/api/collections/${id}`, { color });
          const idx = collections.findIndex((c) => sameId(c.id, id));
          if (idx > -1) collections[idx] = updated;
          render();
        } catch (err) { showToast(err.message); }
      });
    });

    app.querySelectorAll('.va-card').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
    app.querySelectorAll('.va-nav-item[data-view]').forEach((item) => {
      const view = item.dataset.view;
      if (view === 'all') return;
      item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drop-target'); });
      item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        item.classList.remove('drop-target');
        const postId = e.dataTransfer.getData('text/plain');
        const newCollectionId = view === 'unsorted' ? null : collectionIdFromView(view);
        try {
          const updated = await apiPatch(`/api/posts/${postId}`, { collection_id: newCollectionId });
          if (activePost && sameId(activePost.id, postId)) activePost = updated;
          const collName = newCollectionId ? (getCollection(newCollectionId)?.name || '') : 'To sort';
          await refreshAfterMutation();
          showToast(`Moved to ${collName}`);
        } catch (err) { showToast(err.message); }
      });
    });

    const groupByTagBtn = $('#groupByTagBtn');
    if (groupByTagBtn) groupByTagBtn.addEventListener('click', () => { state.groupByTag = !state.groupByTag; render(); });

    const detailClose = $('#detailClose'); if (detailClose) detailClose.addEventListener('click', async () => { await closeDetailPanel(); await refreshAfterMutation(); });
    const detailDone = $('#detailDone'); if (detailDone) detailDone.addEventListener('click', async () => { await closeDetailPanel(); await refreshAfterMutation(); });
    const detailCancelNew = $('#detailCancelNew'); if (detailCancelNew) detailCancelNew.addEventListener('click', () => { state.detailMode = null; activePost = null; resetDetailPopovers(); render(); });
    const detailDelete = $('#detailDelete'); if (detailDelete) detailDelete.addEventListener('click', () => {
      const id = activePost.id;
      confirmAction('Delete this post?', 'This removes it for good.', async () => {
        try {
          await apiDelete(`/api/posts/${id}`);
          state.detailMode = null; activePost = null; resetDetailPopovers();
          await refreshAfterMutation();
        } catch (err) { showToast(err.message); }
      });
    });
    const detailSubmitNew = $('#detailSubmitNew'); if (detailSubmitNew) detailSubmitNew.addEventListener('click', async () => {
      const link = $('#d-link').value.trim();
      if (!link) { showToast('Add a link first'); return; }
      const payload = {
        link,
        provenance: 'manual',
        collection_id: $('#d-collection').value || null,
        description: $('#d-description').value.trim(),
        note: $('#d-post-note').value.trim(),
      };
      if (newPostTitleManual) payload.title = $('#d-title').value.trim();
      detailSubmitNew.disabled = true;
      try {
        const created = await apiPost('/api/posts', payload);
        for (const tagId of newPostTagIds) {
          await apiPost(`/api/posts/${created.id}/tags`, { tag_id: tagId });
        }
        state.detailMode = null; activePost = null; resetDetailPopovers();
        await refreshAfterMutation();
        showToast('Post added');
      } catch (err) {
        showToast(err.message);
      } finally {
        detailSubmitNew.disabled = false;
      }
    });

    const tagAddBtn = $('#tagAddBtn');
    if (tagAddBtn) tagAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.tagEditingId = null;
      state.tagAdderOpen = !state.tagAdderOpen;
      state.tagQuery = '';
      render();
      if (state.tagAdderOpen) {
        setTimeout(() => { const el = $('#tagSearchInput'); if (el) el.focus(); }, 30);
        setTimeout(() => document.addEventListener('click', handleOutsideTagPopoverClick, { once: true }), 0);
      }
    });
    const tagSearchInput = $('#tagSearchInput');
    if (tagSearchInput) tagSearchInput.addEventListener('input', (e) => {
      state.tagQuery = e.target.value;
      const caret = e.target.selectionStart;
      render();
      const again = $('#tagSearchInput');
      if (again) { again.focus(); again.setSelectionRange(caret, caret); }
      setTimeout(() => document.addEventListener('click', handleOutsideTagPopoverClick, { once: true }), 0);
    });
    app.querySelectorAll('[data-action="attach-tag"]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); addTagToCurrent(btn.dataset.tagid); });
    });
    const createTagBtn = $('[data-action="create-tag"]');
    if (createTagBtn) createTagBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = state.tagQuery.trim();
      if (!name) return;
      try {
        const t = await apiPost('/api/tags', { name, color: PALETTE[tags.length % PALETTE.length] });
        tags.push(t);
        await addTagToCurrent(t.id);
      } catch (err) { showToast(err.message); }
    });
    app.querySelectorAll('[data-action="remove-tag"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tagId = btn.dataset.tagid;
        if (state.detailMode === 'new') {
          newPostTagIds = newPostTagIds.filter((id) => !sameId(id, tagId));
          render();
          return;
        }
        try {
          const updated = await apiDelete(`/api/posts/${activePost.id}/tags/${tagId}`);
          activePost = updated;
        } catch (err) { showToast(err.message); }
        render();
      });
    });
    app.querySelectorAll('[data-action="edit-tag"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.tagAdderOpen = false;
        state.tagEditingId = state.tagEditingId === btn.dataset.tagid ? null : btn.dataset.tagid;
        render();
        if (state.tagEditingId) {
          setTimeout(() => { const el = $('#tagRenameInput'); if (el) { el.focus(); el.select(); } }, 30);
          setTimeout(() => document.addEventListener('click', handleOutsideTagPopoverClick, { once: true }), 0);
        }
      });
    });
    const tagRenameInput = $('#tagRenameInput');
    if (tagRenameInput) tagRenameInput.addEventListener('input', (e) => {
      const tagId = tagRenameInput.dataset.tagid;
      const t = getTag(tagId);
      if (t) {
        t.name = e.target.value;
        document.querySelectorAll(`[data-action="edit-tag"][data-tagid="${tagId}"]`).forEach((el) => { el.textContent = t.name || '(untitled)'; });
      }
      tagSaver.schedule(tagId, { name: e.target.value }, saveTagFields);
    });
    app.querySelectorAll('[data-action="pick-tag-color"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tagId = btn.dataset.tagid;
        try {
          const updated = await apiPatch(`/api/tags/${tagId}`, { color: btn.dataset.color });
          const idx = tags.findIndex((t) => sameId(t.id, tagId));
          if (idx > -1) tags[idx] = updated;
        } catch (err) { showToast(err.message); }
        render();
      });
    });

    if (state.detailMode !== null && state.detailMode !== 'new') {
      const dCollection = $('#d-collection');
      if (dCollection) dCollection.addEventListener('change', async (e) => {
        const value = e.target.value || null;
        try {
          const updated = await apiPatch(`/api/posts/${activePost.id}`, { collection_id: value });
          activePost = updated;
          await refreshAfterMutation();
        } catch (err) { showToast(err.message); }
      });
      const dPostNote = $('#d-post-note');
      if (dPostNote) dPostNote.addEventListener('input', (e) => {
        if (activePost) activePost.note = e.target.value;
        postSaver.schedule(activePost.id, { note: e.target.value }, savePostFields);
      });
    } else if (state.detailMode === 'new') {
      const dLink = $('#d-link');
      if (dLink) dLink.addEventListener('input', (e) => {
        newPostDraft.link = e.target.value;
        debouncedLinkPreview(e.target.selectionStart);
      });
      const dPostNote = $('#d-post-note');
      if (dPostNote) dPostNote.addEventListener('input', (e) => { newPostDraft.note = e.target.value; });
    }
    const dTitle = $('#d-title');
    const dDescription = $('#d-description');
    if (dDescription) dDescription.addEventListener('input', (e) => {
      if (state.detailMode === 'new') {
        newPostDraft.description = e.target.value;
        if (!newPostTitleManual) {
          newPostDraft.title = firstSentence(e.target.value);
          if (dTitle) dTitle.value = newPostDraft.title;
        }
        return;
      }
      if (!activePost) return;
      activePost.description = e.target.value;
      if (!activePost.title_manual) {
        activePost.title = firstSentence(activePost.description);
        if (dTitle) dTitle.value = activePost.title;
        patchCardTitle(activePost);
      }
      patchCardDesc(activePost);
      postSaver.schedule(activePost.id, { description: e.target.value }, savePostFields);
    });
    if (dTitle) dTitle.addEventListener('input', () => {
      if (state.detailMode === 'new') { newPostTitleManual = true; newPostDraft.title = dTitle.value; return; }
      if (!activePost) return;
      activePost.title = dTitle.value;
      activePost.title_manual = 1;
      patchCardTitle(activePost);
      postSaver.schedule(activePost.id, { title: dTitle.value }, savePostFields);
    });
  }
  function patchCardTitle(p) {
    const el = document.querySelector(`.va-card[data-id="${p.id}"] .post-title`);
    if (el) { el.textContent = p.title || 'Untitled'; el.classList.toggle('note-placeholder', !p.title); }
  }
  function patchCardDesc(p) {
    const el = document.querySelector(`.va-card[data-id="${p.id}"] .post-desc`);
    if (el) { el.textContent = p.description || 'No description yet.'; el.classList.toggle('note-placeholder', !p.description); }
  }
  function handleOutsideColorPopoverClick(e) {
    const pop = document.getElementById('colorPopover');
    if (pop && !pop.contains(e.target)) {
      state.colorPopoverFor = null;
      render();
    }
  }
  function handleOutsideTagPopoverClick(e) {
    const pop = document.getElementById('tagPopover') || document.getElementById('tagEditPopover');
    if (pop && !pop.contains(e.target) && !e.target.closest('#tagAddBtn') && !e.target.closest('[data-action="edit-tag"]')) {
      state.tagAdderOpen = false;
      state.tagEditingId = null;
      render();
    }
  }
  async function addTagToCurrent(tagId) {
    const ids = currentTagIds();
    if (ids.some((id) => sameId(id, tagId)) || ids.length >= 4) {
      state.tagAdderOpen = false; state.tagQuery = ''; render();
      return;
    }
    state.tagAdderOpen = false; state.tagQuery = '';
    if (state.detailMode === 'new') {
      newPostTagIds.push(tagId);
      render();
      return;
    }
    try {
      const updated = await apiPost(`/api/posts/${activePost.id}/tags`, { tag_id: tagId });
      activePost = updated;
    } catch (err) { showToast(err.message); }
    render();
  }
  function resetDetailPopovers() {
    state.tagAdderOpen = false;
    state.tagEditingId = null;
    state.tagQuery = '';
  }
  async function closeDetailPanel() {
    await flushAllSavers();
    state.detailMode = null;
    activePost = null;
    resetDetailPopovers();
  }
  // Switching the open detail panel straight to a different post (or to the "new post" form)
  // without going through closeDetailPanel() would otherwise drop whatever edit was still
  // sitting in postSaver's debounce window -- flush it first so it's never silently lost.
  async function openPostDetail(id) {
    if (state.detailMode !== null && !sameId(state.detailMode, id)) await flushAllSavers();
    const p = posts.find((x) => sameId(x.id, id));
    if (!p) return;
    resetDetailPopovers();
    activePost = { ...p, tags: (p.tags || []).slice() };
    state.detailMode = id;
    state.collHeaderExpanded = false;
    render();
  }
  async function openPostNew() {
    if (state.detailMode !== null) await flushAllSavers();
    newPostTitleManual = false;
    newPostTagIds = [];
    newPostDraft = { link: '', title: '', description: '', note: '' };
    resetDetailPopovers();
    activePost = null;
    state.detailMode = 'new';
    state.collHeaderExpanded = false;
    render();
  }

  // ---------------- Instagram export import ----------------
  // Field mapping and standing decisions from the wayfinder map (issue #10):
  // Description <- Légende; Title left to the server's auto-derivation (never
  // sent explicitly here); Tags and Post Note are never touched by import;
  // Collection <- Nom, auto-created on first sight, matched by trimmed exact
  // name; dedup is exact-link, against existing Posts and within the batch;
  // re-import only adds new Posts, never reassigns an existing Post's Collection
  // (skipped posts are left completely alone).
  async function resolveImportCollectionId(name, collectionByName, colorCounter) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = collectionByName.get(trimmed);
    if (existing) return existing.id;
    try {
      const created = await apiPost('/api/collections', { name: trimmed, color: PALETTE[colorCounter.next++ % PALETTE.length] });
      collectionByName.set(trimmed, created);
      return created.id;
    } catch (err) {
      // A 409 here means the name differs from an existing collection only by
      // case -- collections.name is UNIQUE COLLATE NOCASE (src/schema.sql) even
      // though our own matching above is case-sensitive. Fall back to that
      // collection instead of failing the whole import over a casing mismatch.
      if (err.status === 409) {
        const refreshed = await apiGet('/api/collections');
        const match = refreshed.find((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase());
        if (match) { collectionByName.set(trimmed, match); return match.id; }
      }
      throw err;
    }
  }

  // Mirrors resolveImportCollectionId, but for Tags (tags.name is also UNIQUE
  // COLLATE NOCASE) -- only the reimport diff's Re-add action (issue #41)
  // needs this, since it has to recreate a tombstoned Post's Tags by name:
  // the snapshot only kept names, not ids (#30).
  async function resolveOrCreateTagId(name, tagByName, colorCounter) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = tagByName.get(trimmed);
    if (existing) return existing.id;
    try {
      const created = await apiPost('/api/tags', { name: trimmed, color: PALETTE[colorCounter.next++ % PALETTE.length] });
      tagByName.set(trimmed, created);
      return created.id;
    } catch (err) {
      if (err.status === 409) {
        const refreshed = await apiGet('/api/tags');
        const match = refreshed.find((t) => t.name.trim().toLowerCase() === trimmed.toLowerCase());
        if (match) { tagByName.set(trimmed, match); return match.id; }
      }
      throw err;
    }
  }

  async function performImport(file) {
    let raw;
    try {
      raw = await file.text();
    } catch {
      showToast('Could not read that file');
      return;
    }
    const parsed = parseInstagramExport(raw);
    if (parsed.length === 0) {
      showToast('Could not find any saved posts in that file');
      return;
    }

    let freshCollections;
    let existingPosts;
    let allTombstones;
    try {
      [freshCollections, existingPosts, allTombstones] = await Promise.all([
        apiGet('/api/collections'),
        apiGet('/api/posts'),
        // Every tombstone, dismissed or not -- computeReimportDiff needs the
        // dismissed ones too, to keep their links out of the normal add loop.
        apiGet('/api/deleted-posts'),
      ]);
    } catch (err) {
      showToast(err.message);
      return;
    }
    const collectionByName = new Map(freshCollections.map((c) => [c.name.trim(), c]));
    const existingLinks = new Set(existingPosts.map((p) => p.link));
    const colorCounter = { next: freshCollections.length };
    const { readdCandidates, dropCandidates, tombstoneByLink } = computeReimportDiff(
      parsed,
      existingPosts,
      allTombstones
    );

    let added = 0;
    let skipped = 0;
    let failed = 0;
    const importedCollectionNames = new Set();
    for (const post of parsed) {
      if (existingLinks.has(post.link)) { skipped++; continue; }
      // issue #41: a link with a live (non-dismissed) tombstone is deferred to
      // the reimport review screen below instead of silently coming back.
      if (tombstoneByLink.has(post.link)) continue;
      try {
        const collectionId = await resolveImportCollectionId(post.collectionName, collectionByName, colorCounter);
        await apiPost('/api/posts', {
          link: post.link,
          provenance: 'instagram-import',
          description: post.description,
          owner_name: post.ownerName,
          owner_username: post.ownerUsername,
          collection_id: collectionId,
        });
        existingLinks.add(post.link);
        if (post.collectionName.trim()) importedCollectionNames.add(post.collectionName.trim());
        added++;
      } catch {
        failed++;
      }
    }

    try {
      await refreshAfterMutation();
    } catch (err) {
      showToast(err.message);
      return;
    }
    const parts = [`Imported ${added} post${added === 1 ? '' : 's'}`];
    if (importedCollectionNames.size) parts.push(`across ${importedCollectionNames.size} collection${importedCollectionNames.size === 1 ? '' : 's'}`);
    if (skipped) parts.push(`skipped ${skipped} already saved`);
    if (failed) parts.push(`${failed} failed`);
    showToast(parts.join(', '));

    // issue #31: the diff only surfaces when at least one Post is affected --
    // a normal import with no gaps behaves exactly as today.
    if (readdCandidates.length || dropCandidates.length) {
      openReimportReview(readdCandidates, dropCandidates);
    }
  }

  // ---------------- reimport diff review (issue #31/#41) ----------------
  // Batched review screen shown after a normal import when the diff found
  // anything: direction (a) rows offer Re-add/Skip, direction (b) rows offer
  // Keep/Drop, each pairable with an opt-in "don't ask again". Held outside
  // `state` (unlike most UI state) since it's only ever touched by this one
  // flow and never needs to survive a full render() rebuild of #app.
  let reimportReview = null; // { readd: [{ exportPost, tombstone, choice, dontAskAgain }], drop: [{ post, choice, dontAskAgain }] }

  function reimportReviewRowHtml(kind, idx, item) {
    if (kind === 'readd') {
      const { tombstone } = item;
      const label = tombstone.title || tombstone.description || tombstone.link;
      const meta = tombstone.collection_name
        ? `Deleted here, still on Instagram &middot; was in ${escapeHtml(tombstone.collection_name)}`
        : 'Deleted here, still on Instagram';
      return `
        <div class="reimport-row" data-kind="readd" data-idx="${idx}">
          <div class="reimport-row-info">
            <div class="reimport-row-title"><a href="${escapeHtml(tombstone.link)}" target="_blank" rel="noopener">${escapeHtml(label)}</a></div>
            <div class="reimport-row-meta">${meta}</div>
          </div>
          <div class="reimport-row-choice">
            <label><input type="radio" name="reimport-readd-${idx}" value="skip" ${item.choice === 'skip' ? 'checked' : ''}> Skip</label>
            <label><input type="radio" name="reimport-readd-${idx}" value="readd" ${item.choice === 'readd' ? 'checked' : ''}> Re-add</label>
          </div>
          <label class="reimport-row-dismiss">
            <input type="checkbox" ${item.dontAskAgain ? 'checked' : ''} ${item.choice !== 'skip' ? 'disabled' : ''}> Don't ask again
          </label>
        </div>`;
    }
    const { post } = item;
    return `
      <div class="reimport-row" data-kind="drop" data-idx="${idx}">
        <div class="reimport-row-info">
          <div class="reimport-row-title"><a href="${escapeHtml(post.link)}" target="_blank" rel="noopener">${escapeHtml(post.title || post.link)}</a></div>
          <div class="reimport-row-meta">No longer in this export</div>
        </div>
        <div class="reimport-row-choice">
          <label><input type="radio" name="reimport-drop-${idx}" value="keep" ${item.choice === 'keep' ? 'checked' : ''}> Keep</label>
          <label><input type="radio" name="reimport-drop-${idx}" value="drop" ${item.choice === 'drop' ? 'checked' : ''}> Drop</label>
        </div>
        <label class="reimport-row-dismiss">
          <input type="checkbox" ${item.dontAskAgain ? 'checked' : ''} ${item.choice !== 'keep' ? 'disabled' : ''}> Don't ask again
        </label>
      </div>`;
  }

  function renderReimportReview() {
    if (!reimportReview) return;
    const parts = [];
    if (reimportReview.readd.length) {
      parts.push('<div class="reimport-section-label">Deleted here, still on Instagram</div>');
      parts.push(reimportReview.readd.map((item, idx) => reimportReviewRowHtml('readd', idx, item)).join(''));
    }
    if (reimportReview.drop.length) {
      parts.push('<div class="reimport-section-label">No longer on Instagram</div>');
      parts.push(reimportReview.drop.map((item, idx) => reimportReviewRowHtml('drop', idx, item)).join(''));
    }
    $('#reimportReviewList').innerHTML = parts.join('');
  }

  function openReimportReview(readdCandidates, dropCandidates) {
    reimportReview = {
      readd: readdCandidates.map((c) => ({ ...c, choice: 'skip', dontAskAgain: false })),
      drop: dropCandidates.map((post) => ({ post, choice: 'keep', dontAskAgain: false })),
    };
    renderReimportReview();
    $('#reimportReviewOverlay').classList.remove('hidden');
  }
  function closeReimportReview() {
    $('#reimportReviewOverlay').classList.add('hidden');
    reimportReview = null;
  }

  // Re-add fully restores the tombstone's snapshot (issue #30/#31): title
  // (only if it had one -- otherwise let the server re-derive it from the
  // description, same as a fresh import), description/note/owner, Collection
  // resolved by name, and Tags resolved/recreated by name. The tombstone row
  // itself needs no explicit delete -- posts.js's create() already clears any
  // tombstone matching the new Post's link (issue #40's re-add invariant).
  async function applyReimportReadd(tombstone, collectionByName, collColorCounter, tagByName, tagColorCounter) {
    const collectionId = await resolveImportCollectionId(tombstone.collection_name || '', collectionByName, collColorCounter);
    const body = {
      link: tombstone.link,
      provenance: 'instagram-import',
      description: tombstone.description,
      note: tombstone.note,
      owner_name: tombstone.owner_name,
      owner_username: tombstone.owner_username,
      collection_id: collectionId,
    };
    if (tombstone.title) body.title = tombstone.title;
    const created = await apiPost('/api/posts', body);

    let tagNames = [];
    try { tagNames = JSON.parse(tombstone.tags || '[]'); } catch { tagNames = []; }
    for (const name of tagNames) {
      try {
        const tagId = await resolveOrCreateTagId(name, tagByName, tagColorCounter);
        if (tagId) await apiPost(`/api/posts/${created.id}/tags`, { tag_id: tagId });
      } catch {
        // Best-effort: a lost Tag (e.g. hit the 4-tag cap) isn't worth failing the re-add itself.
      }
    }
  }

  async function applyReimportReview() {
    if (!reimportReview) return;
    const { readd, drop } = reimportReview;

    let freshCollections;
    let freshTags;
    try {
      [freshCollections, freshTags] = await Promise.all([apiGet('/api/collections'), apiGet('/api/tags')]);
    } catch (err) {
      showToast(err.message);
      return;
    }
    const collectionByName = new Map(freshCollections.map((c) => [c.name.trim(), c]));
    const collColorCounter = { next: freshCollections.length };
    const tagByName = new Map(freshTags.map((t) => [t.name.trim(), t]));
    const tagColorCounter = { next: freshTags.length };

    let readded = 0;
    let dropped = 0;
    let dismissed = 0;
    let failed = 0;

    for (const item of readd) {
      if (item.choice === 'readd') {
        try {
          await applyReimportReadd(item.tombstone, collectionByName, collColorCounter, tagByName, tagColorCounter);
          readded++;
        } catch {
          failed++;
        }
      } else if (item.dontAskAgain) {
        try {
          await apiPatch(`/api/deleted-posts/${item.tombstone.id}`, { dismissed: true });
          dismissed++;
        } catch {
          failed++;
        }
      }
    }

    for (const item of drop) {
      if (item.choice === 'drop') {
        try {
          await apiDelete(`/api/posts/${item.post.id}`);
          dropped++;
        } catch {
          failed++;
        }
      } else if (item.dontAskAgain) {
        try {
          await apiPatch(`/api/posts/${item.post.id}`, { reimport_dismissed: true });
          dismissed++;
        } catch {
          failed++;
        }
      }
    }

    closeReimportReview();
    try {
      await refreshAfterMutation();
    } catch (err) {
      showToast(err.message);
      return;
    }

    const parts = [];
    if (readded) parts.push(`re-added ${readded}`);
    if (dropped) parts.push(`dropped ${dropped}`);
    if (dismissed) parts.push(`${dismissed} dismissed`);
    if (failed) parts.push(`${failed} failed`);
    showToast(parts.length ? parts.join(', ') : 'No changes');
  }

  function bindReimportReviewModalHandlers() {
    const list = $('#reimportReviewList');
    list.addEventListener('change', (e) => {
      const row = e.target.closest('.reimport-row');
      if (!row || !reimportReview) return;
      const item = reimportReview[row.dataset.kind][Number(row.dataset.idx)];
      if (!item) return;
      if (e.target.type === 'radio') {
        item.choice = e.target.value;
        renderReimportReview();
      } else if (e.target.type === 'checkbox') {
        item.dontAskAgain = e.target.checked;
      }
    });
    $('#reimportReviewCancel').addEventListener('click', closeReimportReview);
    $('#reimportReviewOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'reimportReviewOverlay') closeReimportReview();
    });
    $('#reimportReviewApply').addEventListener('click', async () => {
      const applyBtn = $('#reimportReviewApply');
      if (applyBtn) applyBtn.disabled = true;
      try {
        await applyReimportReview();
      } finally {
        if (applyBtn) applyBtn.disabled = false;
      }
    });
  }

  function bindImportInputHandlers() {
    const input = $('#importFileInput');
    if (!input) return;
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      await performImport(file);
    });
  }

  // ---------------- JSON backup/restore ----------------
  // Non-overlapping with Instagram-export import (map #10 Notes): backup
  // mirrors the app's own data 1:1 (src/api/backup.js) and restore is a full
  // wipe-and-replace, distinct from import's additive, dedup'd merge.
  async function performDownloadBackup() {
    let data;
    try {
      data = await apiGet('/api/backup');
    } catch (err) {
      showToast(err.message);
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `socials-organizer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function performRestore(file) {
    let raw;
    try {
      raw = await file.text();
    } catch {
      showToast('Could not read that file');
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      showToast('That file is not valid JSON');
      return;
    }
    try {
      await apiPost('/api/backup/restore', data);
    } catch (err) {
      showToast(err.message);
      return;
    }
    try {
      await closeDetailPanel();
      await refreshAfterMutation();
    } catch (err) {
      showToast(err.message);
      return;
    }
    showToast('Backup restored');
  }

  // Binds the file input's change listener once -- unlike the two menu
  // buttons below, #restoreFileInput lives outside #app (public/index.html)
  // so render()'s app.innerHTML reset never tears it down.
  function bindRestoreInputHandlers() {
    const restoreInput = $('#restoreFileInput');
    if (!restoreInput) return;
    restoreInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      confirmAction(
        'Restore from backup',
        'This replaces all current posts, collections, and tags with the backup’s contents. This cannot be undone.',
        () => performRestore(file)
      );
    });
  }

  // ---------------- new collection modal ----------------
  function renderColorPicker() {
    $('#colorPicker').innerHTML = PALETTE.map((hex) => `<button type="button" data-color="${hex}" style="background:${hex}" class="${state.editingCollectionColor === hex ? 'selected' : ''}"></button>`).join('');
    $('#colorPicker').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { state.editingCollectionColor = b.dataset.color; renderColorPicker(); });
    });
  }
  function openCollectionModal() {
    $('#collModalTitle').textContent = 'New Collection';
    $('#c-name').value = '';
    $('#c-note').value = '';
    state.editingCollectionColor = PALETTE[collections.length % PALETTE.length];
    renderColorPicker();
    $('#collectionOverlay').classList.remove('hidden');
    setTimeout(() => $('#c-name').focus(), 30);
  }
  function closeCollectionModal() { $('#collectionOverlay').classList.add('hidden'); }
  function bindCollectionModalHandlers() {
    $('#collCancel').addEventListener('click', closeCollectionModal);
    $('#collectionOverlay').addEventListener('click', (e) => { if (e.target.id === 'collectionOverlay') closeCollectionModal(); });
    $('#collectionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#c-name').value.trim();
      if (!name) return;
      const data = { name, note: $('#c-note').value.trim(), color: state.editingCollectionColor };
      const submitBtn = $('#collSubmit');
      if (submitBtn) submitBtn.disabled = true;
      try {
        const created = await apiPost('/api/collections', data);
        closeCollectionModal();
        state.view = viewForCollection(created.id);
        await refreshAfterMutation();
      } catch (err) {
        showToast(err.message);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // ---------------- new/rename section modal ----------------
  // Sections have no detail page of their own (decision on #28: name only,
  // no note/color), so this one modal serves both create (editingSectionId
  // null) and rename (editingSectionId set), unlike Collection's modal which
  // only creates -- renaming a Collection happens inline in its header.
  function openSectionModal(id) {
    const editing = id ? getSection(id) : null;
    state.editingSectionId = editing ? String(editing.id) : null;
    $('#sectionModalTitle').textContent = editing ? 'Rename Section' : 'New Section';
    $('#s-name').value = editing ? editing.name : '';
    $('#sectionOverlay').classList.remove('hidden');
    setTimeout(() => $('#s-name').focus(), 30);
  }
  function closeSectionModal() { $('#sectionOverlay').classList.add('hidden'); state.editingSectionId = null; }
  function bindSectionModalHandlers() {
    $('#sectionCancel').addEventListener('click', closeSectionModal);
    $('#sectionOverlay').addEventListener('click', (e) => { if (e.target.id === 'sectionOverlay') closeSectionModal(); });
    $('#sectionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#s-name').value.trim();
      if (!name) return;
      const editingId = state.editingSectionId;
      const submitBtn = $('#sectionSubmit');
      if (submitBtn) submitBtn.disabled = true;
      try {
        if (editingId) await apiPatch(`/api/sections/${editingId}`, { name });
        else await apiPost('/api/sections', { name });
        closeSectionModal();
        await refreshAfterMutation();
      } catch (err) {
        showToast(err.message);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // ---------------- collection deletion modal (keep-or-delete-posts, ADR 0001) ----------------
  function openCollDeleteModal(id) {
    const c = getCollection(id);
    if (!c) return;
    collDeleteTargetId = id;
    $('#collDeleteName').textContent = c.name || '(untitled)';
    $('#collDeleteOverlay').classList.remove('hidden');
  }
  function closeCollDeleteModal() {
    $('#collDeleteOverlay').classList.add('hidden');
    collDeleteTargetId = null;
  }
  async function performCollDelete(deletePosts) {
    const id = collDeleteTargetId;
    if (!id) return;
    closeCollDeleteModal();
    try {
      await apiDelete(`/api/collections/${id}${deletePosts ? '?deletePosts=true' : ''}`);
      if (state.view === viewForCollection(id)) {
        state.view = 'all';
        await closeDetailPanel();
      }
      await refreshAfterMutation();
      showToast(deletePosts ? 'Collection and its posts deleted' : 'Collection deleted');
    } catch (err) { showToast(err.message); }
  }
  function bindCollDeleteModalHandlers() {
    $('#collDeleteCancel').addEventListener('click', closeCollDeleteModal);
    $('#collDeleteOverlay').addEventListener('click', (e) => { if (e.target.id === 'collDeleteOverlay') closeCollDeleteModal(); });
    $('#collDeleteKeepPosts').addEventListener('click', () => performCollDelete(false));
    $('#collDeleteWithPosts').addEventListener('click', () => performCollDelete(true));
  }

  // ---------------- confirm modal ----------------
  function confirmAction(title, body, onConfirm) {
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    state.pendingConfirm = onConfirm;
    $('#confirmOverlay').classList.remove('hidden');
  }
  function bindConfirmModalHandlers() {
    $('#confirmCancel').addEventListener('click', () => { $('#confirmOverlay').classList.add('hidden'); state.pendingConfirm = null; });
    $('#confirmOk').addEventListener('click', () => {
      const action = state.pendingConfirm;
      $('#confirmOverlay').classList.add('hidden');
      state.pendingConfirm = null;
      if (action) action();
    });
    $('#confirmOverlay').addEventListener('click', (e) => { if (e.target.id === 'confirmOverlay') { $('#confirmOverlay').classList.add('hidden'); state.pendingConfirm = null; } });
  }

  function bindGlobalKeydown() {
    document.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        closeCollectionModal();
        closeSectionModal();
        $('#confirmOverlay').classList.add('hidden'); state.pendingConfirm = null;
        closeCollDeleteModal();
        closeReimportReview();
        closeAllMenus();
        if (state.detailMode !== null || state.colorPopoverFor !== null) {
          await closeDetailPanel();
          state.colorPopoverFor = null;
          await refreshAfterMutation();
        }
      }
    });
  }

  // ---------------- init ----------------
  async function init() {
    try {
      await Promise.all([loadCollections(), loadSections(), loadTags(), loadStats(), loadPosts()]);
    } catch (err) {
      $('#app').innerHTML = `<div class="empty"><h2>Couldn't load data</h2><p>${escapeHtml(err.message)}</p></div>`;
      return;
    }
    render();
  }

  // The static-modal bindings and init() touch the DOM/network as soon as they run, so they're
  // gated behind a browser check -- this lets Node require() the file to unit-test the pure
  // helpers below without a document/fetch global in scope.
  if (typeof document !== 'undefined') {
    bindCollectionModalHandlers();
    bindSectionModalHandlers();
    bindCollDeleteModalHandlers();
    bindConfirmModalHandlers();
    bindImportInputHandlers();
    bindRestoreInputHandlers();
    bindReimportReviewModalHandlers();
    bindGlobalKeydown();
    init();
  }

  // Exposed for the pure-logic unit tests in test/frontend/helpers.test.js -- inert in the browser.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      firstSentence,
      parseInstagramLink,
      buildPostsQuery,
      isVideoLink,
      parseInstagramExport,
      computeReimportDiff,
    };
  }
})();
