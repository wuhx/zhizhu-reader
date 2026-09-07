'use strict';

// The reader. Three panes: publishers, a timeline, an article.
//
// An ordinary feed reader. The subscription list is feeds.opml, shipped with the
// app and authoritative on every load; the articles are standard RSS, bodies and
// all. Every item is materialized into IndexedDB once, so every view after that
// is a local query — no pagination, no fetch when an article is opened, and no
// search index to build or keep in step.

const OPML_URL = 'feeds.opml';

// Feeds in flight at once. Enough to hide the latency of two dozen requests on a
// cold load, few enough that one tab does not look like an attack.
const FETCH_CONCURRENCY = 4;

// Characters a minute. Taken from the ratio the old generator used, and wrong in
// the same direction for every article — which is all a reading estimate has to
// be.
const CHARS_PER_MIN = 400;

// The feed carries a <description> for some publishers and not others, so an
// excerpt often has to come off the front of the body.
const EXCERPT_CHARS = 300;

// Rows rendered before handing the rest to an IntersectionObserver. Enough to
// fill any viewport twice over, so the sentinel is never visible on arrival.
const PAGE = 60;

const EXCERPT_FADE = 220;

const LS = { theme: 'zhizhu.theme', view: 'zhizhu.view', sel: 'zhizhu.sel' };

const state = {
  outlines: [],       // the subscription list, in the order feeds.opml gives it
  entries: [],        // the whole catalog, newest first
  byId: new Map(),
  publishers: {},
  view: { kind: 'all', id: null },
  filtered: [],
  rendered: 0,
  selected: null,
  read: new Set(),
  starred: new Set(),
  query: '',
  feedErrors: [],
};

// ---------------------------------------------------------------- storage --
//
// IndexedDB rather than localStorage: the catalog is a few thousand entries and
// read/star state is unbounded, where localStorage is a synchronous ~5 MB box
// that airss-reader had to cap with a 5000-entry FIFO.

const DB_NAME = 'zhizhu';
const DB_VERSION = 2;
let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = event => {
      const d = open.result;
      // The materialized catalog: one record per article, keyed by the feed's
      // guid.
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
      // Bodies, in a store of their own. Boot reads every entry to draw the
      // timeline, so folding a couple of megabytes of article HTML into those
      // records would mean deserializing all of it to render a list of titles.
      if (!d.objectStoreNames.contains('bodies')) d.createObjectStore('bodies');
      // Per-article reading state. Never sent anywhere; this is the whole of it.
      if (!d.objectStoreNames.contains('flags')) d.createObjectStore('flags');
      // Per-feed ETags, and the last subscription list we saw.
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');

      // v1 held the bundle's catalog and its log cursor, and neither means
      // anything now. Flags are deliberately spared: a feed's guid is the same
      // id the bundle used, so read and starred survive the change of source.
      if (event.oldVersion === 1) {
        open.transaction.objectStore('entries').clear();
        open.transaction.objectStore('meta').clear();
      }
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

const NS = {
  content: 'http://purl.org/rss/1.0/modules/content/',
  dc: 'http://purl.org/dc/elements/1.1/',
};

function parseXML(text, what) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  // DOMParser reports a malformed document by handing back one describing the
  // failure, rather than by throwing.
  if (doc.querySelector('parsererror')) throw new Error(`malformed ${what}`);
  return doc;
}

const tagText = (node, tag) => {
  const found = node.getElementsByTagName(tag)[0];
  return found ? found.textContent.trim() : '';
};

const tagTextNS = (node, ns, tag) => {
  const found = node.getElementsByTagNameNS(ns, tag)[0];
  return found ? found.textContent.trim() : '';
};

// pubDate is RFC 822 and dc:date is ISO 8601. The timeline sorts by string
// comparison, so both have to come out in the same shape or the two kinds of
// date never order against each other.
function isoDate(value) {
  if (!value) return '';
  const at = Date.parse(value);
  return Number.isNaN(at) ? '' : new Date(at).toISOString();
}

/**
 * The subscription list, and the whole of it.
 *
 * Shipped with the app and authoritative on every load, so a new publisher
 * arrives with a deploy and there is nothing local to reconcile it against — no
 * seed-versus-live problem, no add-feed UI, and no feed fetched that this file
 * did not name.
 */
async function loadOutlines() {
  const res = await fetch(OPML_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${OPML_URL}`);
  const doc = parseXML(await res.text(), 'OPML');

  const outlines = [];
  for (const node of doc.querySelectorAll('outline[xmlUrl]')) {
    const xmlUrl = node.getAttribute('xmlUrl');
    // The feed's own file name, which is short, stable, and already what
    // monogram() hashes for a publisher's colour.
    const key = new URL(xmlUrl, location.href).pathname
      .replace(/^.*\//, '').replace(/\.xml$/i, '');
    if (!key) continue;
    outlines.push({
      key,
      xmlUrl,
      title: node.getAttribute('text') || node.getAttribute('title') || key,
    });
  }
  return outlines;
}

/**
 * Turn one RSS item into the entry the timeline renders and the body it opens.
 *
 * Everything the old bundle carried and the feed does not — the excerpt, a cover
 * image, the reading estimate — is derived here, once, when the item first
 * arrives, rather than on every render.
 */
function materialize(item, feedKey) {
  const html = tagTextNS(item, NS.content, 'encoded');

  // One parse for both the plain text and the cover. A template's content is
  // inert: no image is fetched and no script runs.
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const plain = (tpl.content.textContent || '').replace(/\s+/g, ' ').trim();
  const cover = tpl.content.querySelector('img[src]');

  const entry = {
    id: tagText(item, 'guid'),
    t: tagText(item, 'title'),
    p: feedKey,
    url: tagText(item, 'link'),
    pub: isoDate(tagTextNS(item, NS.dc, 'date')),
    disc: isoDate(tagText(item, 'pubDate')),
    ex: tagText(item, 'description') || plain.slice(0, EXCERPT_CHARS),
    mins: Math.max(1, Math.round(plain.length / CHARS_PER_MIN)),
    tags: [...item.getElementsByTagName('category')]
      .map(n => n.textContent.trim()).filter(Boolean),
  };
  if (cover) entry.img = cover.getAttribute('src');
  return { entry, html };
}

function store(items) {
  if (!items.length) return Promise.resolve();
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(['entries', 'bodies'], 'readwrite');
    const entries = t.objectStore('entries');
    const bodies = t.objectStore('bodies');
    for (const { entry, html } of items) {
      entries.put(entry);
      bodies.put(html, entry.id);
    }
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  }));
}

/**
 * Cloudflare weakens an ETag whenever it gzips the response — which, for a
 * browser, is always — but compares If-None-Match by exact string rather than
 * by the weak comparison the RFC asks for. Echo back the `W/"…"` it just sent
 * and it answers 200 with the whole body; send the strong form the Worker
 * actually emitted and it answers 304.
 *
 * So the prefix is stripped on the way out. Nothing is lost by it: the strong
 * form is the origin's own tag, and a genuinely weak match is exactly the case
 * a feed reader wants to treat as unchanged anyway.
 */
const strongETag = tag => tag.replace(/^W\//, '');

/**
 * Fetch one feed and materialize it.
 *
 * `cache: 'no-store'` keeps the browser's own cache out of the conditional
 * request, so an unchanged feed arrives here as a 304 rather than being turned
 * back into a 200 from cache — which is what makes the ETag worth storing at
 * all. The Worker allows if-none-match and exposes etag cross-origin, so a
 * refresh that changed nothing costs a header exchange and no parsing.
 */
async function pullFeed(outline, etags) {
  const headers = {};
  if (etags[outline.key]) headers['If-None-Match'] = strongETag(etags[outline.key]);

  const res = await fetch(outline.xmlUrl, { cache: 'no-store', headers });
  if (res.status === 304) return;
  if (!res.ok) throw new Error(`${res.status} ${outline.xmlUrl}`);

  const doc = parseXML(await res.text(), 'feed');
  const items = [];
  for (const item of doc.getElementsByTagName('item')) {
    const made = materialize(item, outline.key);
    if (made.entry.id) items.push(made);
  }
  await store(items);

  const tag = res.headers.get('ETag');
  if (tag) etags[outline.key] = tag; else delete etags[outline.key];
}

/**
 * Drop everything belonging to an outline that is no longer in the list.
 *
 * The only deletion path there is. An item ageing out of a feed's window is
 * emphatically *not* one: a feed is the publisher's most recent N, not a
 * statement about what exists, so treating absence as a delete would cap the
 * local archive at whatever the feed happens to carry.
 */
async function dropMissing(live, etags) {
  for (const key of Object.keys(etags)) if (!live.has(key)) delete etags[key];

  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction(['entries', 'bodies'], 'readwrite');
    const bodies = t.objectStore('bodies');
    const request = t.objectStore('entries').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (!live.has(cursor.value.p)) {
        bodies.delete(cursor.value.id);
        cursor.delete();
      }
      cursor.continue();
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

/** Read the subscription list, then bring every feed in it up to date. */
async function refreshFeeds({ onProgress } = {}) {
  const outlines = await loadOutlines();
  state.outlines = outlines;
  state.publishers = {};
  for (const outline of outlines) state.publishers[outline.key] = { n: outline.title };

  const etags = (await idbGet('meta', 'etags')) || {};
  await dropMissing(new Set(outlines.map(o => o.key)), etags);

  let done = 0;
  const failures = [];
  const queue = outlines.slice();
  const worker = async () => {
    for (let outline = queue.shift(); outline; outline = queue.shift()) {
      // One unreachable or malformed feed is not a failed refresh — the other
      // twenty-five still have news. It is still reported as a degraded sync,
      // so a stale publisher never looks current by accident.
      try {
        await pullFeed(outline, etags);
      } catch (err) {
        const failure = new Error(`could not refresh feed ${outline.key}`, { cause: err });
        failures.push(failure);
        console.error(failure);
      }
      done++;
      onProgress && onProgress(`Refreshing ${done}/${outlines.length}…`);
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));

  await idbPut('meta', etags, 'etags');
  await idbPut('meta', outlines, 'outlines');
  state.feedErrors = failures;
  return idbAll('entries');
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
  const wasOn = set.has(id);
  if (on) set.add(id); else set.delete(id);
  try {
    const current = (await idbGet('flags', id)) || {};
    current[key] = on;
    if (!current.read && !current.starred) {
      await tx('flags', 'readwrite', s => s.delete(id));
    } else {
      await idbPut('flags', current, id);
    }
  } catch (err) {
    if (wasOn) set.add(id); else set.delete(id);
    throw new Error(`could not persist ${key} for article ${id}`, { cause: err });
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
  // From the subscription list rather than from the entries, and in the order
  // the file gives — so a newly added publisher has a row before its first
  // article arrives, and the order of the sidebar is something you can edit.
  const publishers = state.outlines.length
    ? state.outlines.map(o => o.key)
    : [...new Set(state.entries.map(e => e.p))]
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
    try {
      localStorage.setItem(LS.view, JSON.stringify(view));
    } catch (err) {
      console.warn('Could not save the selected view.', err);
    }
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
  const count = state.filtered.length
    ? `${state.filtered.length} article${state.filtered.length === 1 ? '' : 's'}`
    : '';
  const degraded = state.feedErrors.length
    ? `${state.feedErrors.length} feed${state.feedErrors.length === 1 ? '' : 's'} unavailable`
    : '';
  meta.textContent = [count, degraded].filter(Boolean).join(' · ');

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

  const body = el('div', 'card-body');
  const text = el('div', 'card-text');
  const starred = isStarred(entry.id);
  const star = el('button', 'card-star-btn' + (starred ? ' starred' : ''));
  star.type = 'button';
  star.title = 'Star (s)';
  star.setAttribute('aria-label', 'Star article');
  star.setAttribute('aria-pressed', String(starred));
  star.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9Z"/></svg>';
  star.addEventListener('click', event => {
    event.stopPropagation();
    runAction(toggleStar(entry.id), 'Could not update the star.');
  });
  text.appendChild(star);

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
  for (const tag of (entry.tags || []).slice(0, 3)) foot.appendChild(chip(tag));
  if (foot.childNodes.length) text.appendChild(foot);
  body.appendChild(text);

  if (entry.img) {
    const thumb = el('img', 'card-thumb');
    thumb.src = entry.img;
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.referrerPolicy = 'no-referrer';
    thumb.addEventListener('error', () => {
      console.warn(`Could not load the thumbnail for article ${entry.id}.`);
      thumb.remove();
    });
    // The last word on whether this is a cover or a logo. The cover is only the
    // first image in the body, which for plenty of publishers is a masthead or
    // a tracking pixel — here the browser has measured it, so no guessing from
    // the URL is needed.
    thumb.addEventListener('load', () => {
      if (thumb.naturalWidth && thumb.naturalWidth < 200) thumb.remove();
    });
    body.appendChild(thumb);
  }
  node.appendChild(body);

  const when = entry.pub || entry.disc;
  if (when) {
    const time = el('time', 'card-time');
    time.textContent = relTime(when);
    time.dateTime = when;
    time.title = new Date(when).toLocaleDateString();
    node.appendChild(time);
  }

  node.addEventListener('click', () => runAction(open(entry.id), 'Could not open this article.'));
  node.addEventListener('keydown', e => {
    if (e.target === node && e.key === 'Enter') {
      e.preventDefault();
      runAction(open(entry.id), 'Could not open this article.');
    }
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

  // Defence in depth. The feed generator sanitizes too, and more thoroughly —
  // this is here because a feed is markup fetched from somewhere else, and
  // because a rule that runs on both sides costs almost nothing.
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
  try {
    localStorage.setItem(LS.sel, id);
  } catch (err) {
    console.warn('Could not save the selected article.', err);
  }
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

  // The body came down with the listing, so this is a local read and there is
  // no offline case to apologise for: anything in the timeline is readable.
  const html = await idbGet('bodies', id);
  holder.textContent = '';
  holder.appendChild(articleView(entry, html || ''));

  if (!isRead(id)) {
    await setFlag(id, 'read', true);
    const node = document.querySelector(`.card[data-id="${id}"]`);
    if (node) node.classList.add('is-read');
    renderNav();
  }
}

function articleView(entry, html) {
  const wrap = el('div', 'article-inner');

  const header = el('header', 'article-head');
  const title = el('h1');
  title.textContent = entry.t || '(untitled)';
  header.appendChild(title);

  const meta = el('div', 'article-meta');
  const appendMeta = node => {
    if (meta.childNodes.length) meta.appendChild(document.createTextNode(' · '));
    meta.appendChild(node);
  };
  appendMeta(document.createTextNode(publisherName(entry.p)));
  const when = entry.pub || entry.disc;
  if (when) {
    const time = el('time');
    time.textContent = new Date(when).toLocaleDateString(undefined,
      { year: 'numeric', month: 'long', day: 'numeric' });
    appendMeta(time);
  }
  if (entry.url) {
    const original = el('a', 'article-original');
    original.href = entry.url;
    original.target = '_blank';
    original.rel = 'noopener noreferrer';
    original.title = 'Open original (o)';
    original.textContent = 'Open original ↗';
    appendMeta(original);
  }
  if (entry.mins) appendMeta(document.createTextNode(`${entry.mins} min`));
  header.appendChild(meta);
  wrap.appendChild(header);

  const body = el('div', 'article-body');
  body.innerHTML = sanitizer(html);
  wrap.appendChild(body);
  return wrap;
}

async function toggleStar(id) {
  await setFlag(id, 'starred', !isStarred(id));
  applyView();
}

async function markUnread(id) {
  await setFlag(id, 'read', false);
  const node = document.querySelector(`.card[data-id="${id}"]`);
  if (node) node.classList.remove('is-read');
  renderNav();
}

function runAction(action, message) {
  Promise.resolve(action).catch(err => {
    console.error(message, err);
    $('#timeline-meta').textContent = message;
  });
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
  document.addEventListener('keydown', e => {
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
      case 'Enter':
        if (state.selected) {
          e.preventDefault();
          runAction(open(state.selected), 'Could not open this article.');
        }
        break;
      case 'Escape': document.body.classList.remove('reader-open'); break;
      case 'o': {
        if (!state.selected) break;
        const entry = state.byId.get(state.selected);
        if (entry && entry.url) window.open(entry.url, '_blank', 'noopener');
        break;
      }
      case 's': {
        if (!state.selected) break;
        runAction(toggleStar(state.selected), 'Could not update the star.');
        break;
      }
      case 'u': {
        if (!state.selected) break;
        runAction(markUnread(state.selected), 'Could not mark this article unread.');
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
    try {
      localStorage.setItem(LS.theme, next);
    } catch (err) {
      console.warn('Could not save the selected theme.', err);
    }
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
    const entries = await refreshFeeds({
      onProgress: text => { $('#timeline-meta').textContent = text; },
    });
    state.entries = sortEntries(entries);
    state.byId = new Map(state.entries.map(e => [e.id, e]));
    applyView();
  } catch (err) {
    console.error('Could not refresh the feeds.', err);
    $('#timeline-meta').textContent = manual
      ? 'Could not reach the server.'
      : 'Could not refresh the feeds.';
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
  } catch (err) {
    console.warn('Could not restore the selected view.', err);
  }

  await loadFlags();

  // Render whatever is already stored before touching the network, so a
  // returning reader sees their timeline immediately and offline works. The
  // outlines are kept alongside for the same reason: the sidebar needs its
  // names before feeds.opml has been read again.
  const cached = await idbAll('entries');
  const outlines = await idbGet('meta', 'outlines');
  if (outlines) {
    state.outlines = outlines;
    for (const outline of outlines) state.publishers[outline.key] = { n: outline.title };
  }
  if (cached.length) {
    state.entries = sortEntries(cached);
    state.byId = new Map(state.entries.map(e => [e.id, e]));
    applyView();
  }

  await refresh();

  let last = null;
  try {
    last = localStorage.getItem(LS.sel);
  } catch (err) {
    console.warn('Could not restore the selected article.', err);
  }
  if (last && state.byId.has(last)) {
    state.selected = last;
    for (const node of document.querySelectorAll('.card')) {
      node.classList.toggle('is-selected', node.dataset.id === last);
    }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => {
      navigator.serviceWorker.controller?.postMessage({ type: 'zhizhu-hello' });
    }).catch(err => console.error('Could not register the service worker.', err));
  }

  // A tab left open picks up new articles when it is looked at again rather
  // than only on reload. Cheap: every unchanged feed answers 304.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

boot().catch(err => {
  console.error('Could not start the reader.', err);
  $('#timeline-meta').textContent = 'Could not start the reader.';
});
