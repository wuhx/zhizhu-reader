'use strict';

// The reader. Three panes: publishers, a timeline, an article.
//
// The catalog arrives as an append-only log and is materialized into IndexedDB
// once; every view after that is a local query. There is no pagination, no
// per-feed fetch and no search index — the whole index is already here.

const DATA = 'data/';
const HEAD_URL = DATA + 'head.json';

// Rows rendered before handing the rest to an IntersectionObserver. Enough to
// fill any viewport twice over, so the sentinel is never visible on arrival.
const PAGE = 60;

const EXCERPT_FADE = 220;

const LS = { theme: 'zhizhu.theme', view: 'zhizhu.view', sel: 'zhizhu.sel' };

const state = {
  head: null,
  entries: [],        // the whole catalog, newest first
  byId: new Map(),
  publishers: {},
  view: { kind: 'all', id: null },
  filtered: [],
  rendered: 0,
  selected: null,
  doc: null,           // the article currently open, so the toolbar needs no refetch
  read: new Set(),
  starred: new Set(),
  query: '',
};

// ---------------------------------------------------------------- storage --
//
// IndexedDB rather than localStorage: the catalog is a few thousand entries and
// read/star state is unbounded, where localStorage is a synchronous ~5 MB box
// that airss-reader had to cap with a 5000-entry FIFO.

const DB_NAME = 'zhizhu';
const DB_VERSION = 1;
let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      // The materialized catalog: one record per article, keyed by id.
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
      // Per-article reading state. Never sent anywhere; this is the whole of it.
      if (!d.objectStoreNames.contains('flags')) d.createObjectStore('flags');
      // Sync cursor and the last head we applied.
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

// The value is captured in the request's own onsuccess rather than read off it
// at completion. Reading `request.result` and falling back to the request when
// it is undefined -- which is what a missing record gives you -- silently hands
// back an IDBRequest, and storing that later fails with a clone error a long
// way from the cause.
function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const request = fn(t.objectStore(store));
    let value;
    if (request && typeof request.addEventListener === 'function') {
      request.onsuccess = () => { value = request.result; };
    }
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error);
  }));
}

const idbGet = (store, key) => tx(store, 'readonly', s => s.get(key));
const idbPut = (store, value, key) => tx(store, 'readwrite', s => s.put(value, key));
const idbAll = store => tx(store, 'readonly', s => s.getAll());

// ------------------------------------------------------------------- sync --

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function seqName(n) {
  return String(n).padStart(6, '0') + '.json';
}

/**
 * Bring the local catalog up to the published head.
 *
 * The same walk the generator's `replay` does, and deliberately so: a snapshot
 * is only ever what a correct client would already be holding, so the two
 * cannot disagree about what the catalog contains.
 */
async function sync({ onProgress } = {}) {
  const head = await fetchJSON(HEAD_URL, { cache: 'no-store' });
  const local = (await idbGet('meta', 'cursor')) || { seq: 0, epoch: null };

  let cursor = local.seq;
  let entries = new Map();

  // A new epoch means the publisher changed the shape of the bundle out from
  // under us, so nothing local can be trusted incrementally.
  const stale = local.epoch && head.epoch && local.epoch !== head.epoch;
  if (!stale && cursor >= head.snapshot) {
    for (const entry of await idbAll('entries')) entries.set(entry.id, entry);
  } else if (head.snapshot) {
    onProgress && onProgress('Loading catalog…');
    const snap = await fetchJSON(`${DATA}snapshot/${seqName(head.snapshot)}`);
    for (const entry of snap.entries) entries.set(entry.id, entry);
    cursor = head.snapshot;
  } else {
    cursor = 0;
  }

  for (let seq = cursor + 1; seq <= head.latest; seq++) {
    onProgress && onProgress(`Syncing ${seq}/${head.latest}…`);
    let log;
    try {
      log = await fetchJSON(`${DATA}log/${seqName(seq)}`);
    } catch {
      // Pruned below a snapshot we have already applied. Not an error: the
      // snapshot subsumed it.
      continue;
    }
    for (const entry of log.put || []) entries.set(entry.id, entry);
    for (const id of log.del || []) entries.delete(id);
  }

  await db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(['entries', 'meta'], 'readwrite');
    const store = t.objectStore('entries');
    store.clear();
    for (const entry of entries.values()) store.put(entry);
    t.objectStore('meta').put({ seq: head.latest, epoch: head.epoch }, 'cursor');
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  }));

  state.head = head;
  state.publishers = head.publishers || {};
  return entries;
}

// ------------------------------------------------------------------ model --

function sortEntries(entries) {
  // Newest first by publication, falling back to discovery for the many
  // sources that publish no date at all.
  return [...entries].sort((a, b) =>
    (b.pub || b.disc || '').localeCompare(a.pub || a.disc || ''));
}

function publisherName(id) {
  const p = state.publishers[id];
  return (p && p.n) || id;
}

function isRead(id) { return state.read.has(id); }
function isStarred(id) { return state.starred.has(id); }

async function setFlag(id, key, on) {
  const set = key === 'read' ? state.read : state.starred;
  if (on) set.add(id); else set.delete(id);
  const current = (await idbGet('flags', id)) || {};
  current[key] = on;
  if (!current.read && !current.starred) {
    await tx('flags', 'readwrite', s => s.delete(id));
  } else {
    await idbPut('flags', current, id);
  }
}

async function loadFlags() {
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction('flags', 'readonly');
    const request = t.objectStore('flags').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.read) state.read.add(cursor.key);
      if (cursor.value.starred) state.starred.add(cursor.key);
      cursor.continue();
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

// ------------------------------------------------------------------ views --

function applyView() {
  const { kind, id } = state.view;
  let list = state.entries;

  if (kind === 'publisher') list = list.filter(e => e.p === id);
  else if (kind === 'tag') list = list.filter(e => (e.tags || []).includes(id));
  else if (kind === 'starred') list = list.filter(e => isStarred(e.id));
  else if (kind === 'unread') list = list.filter(e => !isRead(e.id));
  else if (kind === 'today') {
    const cutoff = new Date(Date.now() - 864e5).toISOString();
    list = list.filter(e => (e.disc || '') >= cutoff);
  }

  const q = state.query.trim().toLowerCase();
  if (q) {
    list = list.filter(e =>
      (e.t || '').toLowerCase().includes(q) ||
      (e.ex || '').toLowerCase().includes(q) ||
      publisherName(e.p).toLowerCase().includes(q));
  }

  state.filtered = list;
  state.rendered = 0;
  renderTimeline();
  renderNav();
}

// --------------------------------------------------------------- rendering --

const $ = sel => document.querySelector(sel);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

function relTime(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 6e4);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h';
  const days = Math.round(hours / 24);
  if (days < 30) return days + 'd';
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function monogram(id) {
  const name = publisherName(id);
  const node = el('span', 'mono');
  node.textContent = (name.trim()[0] || '?').toUpperCase();
  // A stable colour per publisher, so the sidebar is scannable without icons.
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  node.style.background = `hsl(${hash % 360} 55% 45%)`;
  return node;
}

function renderNav() {
  const nav = $('#nav');
  nav.textContent = '';

  const unread = state.entries.filter(e => !isRead(e.id)).length;
  const starred = state.starred.size;
  const groups = [
    ['unread', 'Unread', unread],
    ['today', 'Today', null],
    ['starred', 'Starred', starred],
    ['all', 'All', state.entries.length],
  ];

  const top = el('div', 'nav-group');
  for (const [kind, label, count] of groups) {
    top.appendChild(navRow({ kind, id: null }, label, count, null));
  }
  nav.appendChild(top);

  const counts = new Map();
  for (const entry of state.entries) {
    if (isRead(entry.id)) continue;
    counts.set(entry.p, (counts.get(entry.p) || 0) + 1);
  }
  const publishers = [...new Set(state.entries.map(e => e.p))]
    .sort((a, b) => publisherName(a).localeCompare(publisherName(b)));

  const heading = el('div', 'nav-heading');
  heading.textContent = 'Publishers';
  nav.appendChild(heading);

  const group = el('div', 'nav-group');
  for (const id of publishers) {
    group.appendChild(navRow({ kind: 'publisher', id }, publisherName(id), counts.get(id) || 0, id));
  }
  nav.appendChild(group);
}

function navRow(view, label, count, publisherId) {
  const row = el('button', 'nav-row');
  row.type = 'button';
  if (state.view.kind === view.kind && state.view.id === view.id) row.classList.add('active');
  if (publisherId) row.appendChild(monogram(publisherId));
  const text = el('span', 'nav-label');
  text.textContent = label;
  row.appendChild(text);
  if (count) {
    const badge = el('span', 'nav-count');
    badge.textContent = count > 999 ? '999+' : String(count);
    row.appendChild(badge);
  }
  row.addEventListener('click', () => {
    state.view = view;
    try { localStorage.setItem(LS.view, JSON.stringify(view)); } catch (e) {}
    document.body.classList.remove('sidebar-open');
    applyView();
  });
  return row;
}

function renderTimeline() {
  const cards = $('#cards');
  if (state.rendered === 0) cards.textContent = '';

  const slice = state.filtered.slice(state.rendered, state.rendered + PAGE);
  for (const entry of slice) cards.appendChild(card(entry));
  state.rendered += slice.length;

  const meta = $('#timeline-meta');
  meta.textContent = state.filtered.length
    ? `${state.filtered.length} article${state.filtered.length === 1 ? '' : 's'}`
    : '';

  if (!state.filtered.length) {
    const empty = el('div', 'empty');
    empty.textContent = state.query ? 'Nothing matches that.' : 'Nothing here yet.';
    cards.appendChild(empty);
    return;
  }
  if (state.rendered < state.filtered.length) cards.appendChild(sentinel());
}

let observer = null;
function sentinel() {
  const node = el('div', 'sentinel');
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(entries => {
    if (!entries.some(e => e.isIntersecting)) return;
    observer.disconnect();
    node.remove();
    renderTimeline();
  }, { rootMargin: '600px' });
  observer.observe(node);
  return node;
}

function card(entry) {
  const node = el('article', 'card');
  node.dataset.id = entry.id;
  node.setAttribute('role', 'listitem');
  node.tabIndex = 0;
  if (isRead(entry.id)) node.classList.add('is-read');
  if (state.selected === entry.id) node.classList.add('is-selected');

  const head = el('div', 'card-head');
  head.appendChild(monogram(entry.p));
  const who = el('span', 'card-pub');
  who.textContent = publisherName(entry.p);
  head.appendChild(who);
  const when = el('time', 'card-time');
  when.textContent = relTime(entry.pub || entry.disc);
  head.appendChild(when);
  if (isStarred(entry.id)) {
    const star = el('span', 'card-star');
    star.textContent = '★';
    head.appendChild(star);
  }
  node.appendChild(head);

  const body = el('div', 'card-body');
  const text = el('div', 'card-text');
  const title = el('h3', 'card-title');
  title.textContent = entry.t || '(untitled)';
  text.appendChild(title);
  if (entry.ex) {
    const excerpt = el('p', 'card-excerpt');
    excerpt.textContent = entry.ex.slice(0, EXCERPT_FADE);
    text.appendChild(excerpt);
  }
  const foot = el('div', 'card-foot');
  if (entry.mins) foot.appendChild(chip(`${entry.mins} min`));
  if (entry.q && entry.q !== 'ok') foot.appendChild(chip(entry.q, 'chip-warn'));
  for (const tag of (entry.tags || []).slice(0, 3)) foot.appendChild(chip(tag));
  if (foot.childNodes.length) text.appendChild(foot);
  body.appendChild(text);

  if (entry.img) {
    const thumb = el('img', 'card-thumb');
    thumb.src = entry.img;
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.referrerPolicy = 'no-referrer';
    thumb.addEventListener('error', () => thumb.remove());
    // The last word on whether this is a cover or a logo. Some publishers point
    // og:image at an 80x80 site mark, and the generator can only catch that
    // when the archive happens to have stored the file — here the browser has
    // measured it, so no guessing from the URL is needed.
    thumb.addEventListener('load', () => {
      if (thumb.naturalWidth && thumb.naturalWidth < 200) thumb.remove();
    });
    body.appendChild(thumb);
  }
  node.appendChild(body);

  node.addEventListener('click', () => open(entry.id));
  node.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); open(entry.id); }
  });
  return node;
}

function chip(label, cls) {
  const node = el('span', 'chip' + (cls ? ' ' + cls : ''));
  node.textContent = label;
  return node;
}

// ----------------------------------------------------------------- article --

const sanitizer = (() => {
  const BLOCK = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'IFRAME', 'OBJECT',
    'EMBED', 'FORM', 'NOSCRIPT', 'TEMPLATE', 'BASE']);

  // Defence in depth. The generator sanitizes too, and more thoroughly — this
  // is here because the bundle is a static file that anything could be serving,
  // and because a rule that runs on both sides costs almost nothing.
  return function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    for (const node of tpl.content.querySelectorAll('*')) {
      if (BLOCK.has(node.tagName)) { node.remove(); continue; }
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith('on')) node.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'src') &&
                 (value.startsWith('javascript:') || value.startsWith('data:text/html'))) {
          node.removeAttribute(attr.name);
        } else if (name === 'style' && /position\s*:\s*(fixed|sticky)/.test(value)) {
          node.removeAttribute(attr.name);
        }
      }
      if (node.tagName === 'A') {
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
      }
      if (node.tagName === 'IMG') {
        node.loading = 'lazy';
        node.referrerPolicy = 'no-referrer';
      }
      if (node.tagName === 'TABLE') {
        const wrap = el('div', 'tbl-wrap');
        node.parentNode.insertBefore(wrap, node);
        wrap.appendChild(node);
      }
    }
    return tpl.innerHTML;
  };
})();

async function open(id) {
  const entry = state.byId.get(id);
  if (!entry) return;

  state.selected = id;
  try { localStorage.setItem(LS.sel, id); } catch (e) {}
  for (const node of document.querySelectorAll('.card')) {
    node.classList.toggle('is-selected', node.dataset.id === id);
  }
  document.body.classList.add('reader-open');

  const holder = $('#article');
  const empty = $('#reader-empty');
  empty.hidden = true;
  holder.hidden = false;
  holder.textContent = '';
  $('#reader-scroll').scrollTop = 0;

  const loading = el('p', 'loading');
  loading.textContent = 'Loading…';
  holder.appendChild(loading);

  let doc;
  try {
    doc = await fetchJSON(`${DATA}articles/${id}.json`);
  } catch (err) {
    holder.textContent = '';
    const failed = el('p', 'loading');
    failed.textContent = 'Could not load this article. It may not be cached for offline reading yet.';
    holder.appendChild(failed);
    return;
  }

  state.doc = doc;
  holder.textContent = '';
  holder.appendChild(articleView(doc, entry));

  if (!isRead(id)) {
    await setFlag(id, 'read', true);
    const node = document.querySelector(`.card[data-id="${id}"]`);
    if (node) node.classList.add('is-read');
    renderNav();
  }
  syncStarButton();
}

function articleView(doc, entry) {
  const wrap = el('div', 'article-inner');

  const header = el('header', 'article-head');
  const title = el('h1');
  title.textContent = doc.title || '(untitled)';
  header.appendChild(title);

  const meta = el('div', 'article-meta');
  meta.appendChild(document.createTextNode(publisherName(doc.publisher)));
  const when = doc.published_at || doc.discovered_at;
  if (when) {
    const time = el('time');
    time.textContent = new Date(when).toLocaleDateString(undefined,
      { year: 'numeric', month: 'long', day: 'numeric' });
    meta.appendChild(document.createTextNode(' · '));
    meta.appendChild(time);
  }
  if (entry && entry.mins) meta.appendChild(document.createTextNode(` · ${entry.mins} min`));
  header.appendChild(meta);
  wrap.appendChild(header);

  // Said out loud rather than left for the reader to discover: a thin or poor
  // extraction is usually a page the original view handles perfectly well.
  if (doc.quality && doc.quality !== 'ok') {
    const note = el('div', 'notice');
    note.textContent = doc.quality === 'poor'
      ? 'Not much text came out of this capture — the original page is likely to read better.'
      : 'This extraction looks short. The original page may have more.';
    const link = el('a');
    link.href = doc.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open original';
    note.appendChild(document.createTextNode(' '));
    note.appendChild(link);
    wrap.appendChild(note);
  }

  const body = el('div', 'article-body');
  body.innerHTML = sanitizer(doc.html || '');
  wrap.appendChild(body);
  return wrap;
}

function syncStarButton() {
  const btn = $('#star-btn');
  btn.classList.toggle('on', !!(state.selected && isStarred(state.selected)));

  // From the document already open, not a second fetch for it: `open` holds it,
  // and the URL is the only thing this needs.
  const original = $('#original-btn');
  const url = state.doc && state.doc.id === state.selected ? state.doc.url : null;
  original.style.visibility = url ? 'visible' : 'hidden';
  original.href = url || '#';
}

// ------------------------------------------------------------------- input --

function move(delta) {
  const list = state.filtered;
  if (!list.length) return;
  const at = list.findIndex(e => e.id === state.selected);
  const next = at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + delta));
  // Render further rows if the selection is walking past what is on screen.
  while (next >= state.rendered && state.rendered < list.length) renderTimeline();
  const entry = list[next];
  state.selected = entry.id;
  for (const node of document.querySelectorAll('.card')) {
    node.classList.toggle('is-selected', node.dataset.id === entry.id);
  }
  const node = document.querySelector(`.card[data-id="${entry.id}"]`);
  if (node) node.scrollIntoView({ block: 'nearest' });
}

function wireKeys() {
  document.addEventListener('keydown', async e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); return; }
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case 'j': case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'k': case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'Enter': if (state.selected) { e.preventDefault(); open(state.selected); } break;
      case 'Escape': document.body.classList.remove('reader-open'); break;
      case 'o': {
        if (!state.selected) break;
        const href = $('#original-btn').href;
        if (href && href !== '#') window.open(href, '_blank', 'noopener');
        break;
      }
      case 's': {
        if (!state.selected) break;
        await setFlag(state.selected, 'starred', !isStarred(state.selected));
        syncStarButton();
        applyView();
        break;
      }
      case 'u': {
        if (!state.selected) break;
        await setFlag(state.selected, 'read', false);
        const node = document.querySelector(`.card[data-id="${state.selected}"]`);
        if (node) node.classList.remove('is-read');
        renderNav();
        break;
      }
    }
  });
}

function wireChrome() {
  $('#menu-btn').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  $('#scrim').addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  $('#back-btn').addEventListener('click', () => document.body.classList.remove('reader-open'));
  $('#help-btn').addEventListener('click', () => $('#help').showModal());

  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(LS.theme, next); } catch (e) {}
  });

  $('#star-btn').addEventListener('click', async () => {
    if (!state.selected) return;
    await setFlag(state.selected, 'starred', !isStarred(state.selected));
    syncStarButton();
    applyView();
  });

  let timer = null;
  $('#search').addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = e.target.value; applyView(); }, 120);
  });

  $('#sync-btn').addEventListener('click', () => refresh({ manual: true }));

  const pill = $('#update-pill');
  const showPill = () => { pill.hidden = false; };
  if (window.zhizhuUpdateReady) showPill();
  document.addEventListener('zhizhu-update', showPill);
  pill.addEventListener('click', () => location.reload());
}

// -------------------------------------------------------------------- boot --

async function refresh({ manual = false } = {}) {
  const btn = $('#sync-btn');
  btn.classList.add('spinning');
  try {
    const entries = await sync({
      onProgress: text => { $('#timeline-meta').textContent = text; },
    });
    state.entries = sortEntries(entries.values());
    state.byId = new Map(state.entries.map(e => [e.id, e]));
    applyView();
  } catch (err) {
    if (manual) $('#timeline-meta').textContent = 'Could not reach the server.';
  } finally {
    btn.classList.remove('spinning');
  }
}

async function boot() {
  wireChrome();
  wireKeys();

  try {
    const saved = JSON.parse(localStorage.getItem(LS.view) || 'null');
    if (saved && saved.kind) state.view = saved;
  } catch (e) {}

  await loadFlags();

  // Render whatever is already stored before touching the network, so a
  // returning reader sees their timeline immediately and offline works.
  const cached = await idbAll('entries');
  const meta = await idbGet('meta', 'head');
  if (cached.length) {
    state.publishers = (meta && meta.publishers) || {};
    state.entries = sortEntries(cached);
    state.byId = new Map(state.entries.map(e => [e.id, e]));
    applyView();
  }

  await refresh();
  if (state.head) await idbPut('meta', { publishers: state.head.publishers }, 'head');

  const last = localStorage.getItem(LS.sel);
  if (last && state.byId.has(last)) {
    state.selected = last;
    for (const node of document.querySelectorAll('.card')) {
      node.classList.toggle('is-selected', node.dataset.id === last);
    }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => {
      navigator.serviceWorker.controller?.postMessage({ type: 'zhizhu-hello' });
    }).catch(() => {});
  }

  // A publish lands as a new head.json, so a tab left open picks it up when it
  // is looked at again rather than only on reload.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

boot();
