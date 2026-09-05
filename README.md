# zhizhu-reader

The reading front end for the [zhizhu](https://github.com/wuhx/zhizhu) article
archive, and the bundle it reads.

This repo is an **artifact**. Nothing here is edited by hand except the app
shell — `index.html`, `sw.js`, `assets/` — and everything under `data/` is
written by `reader/build.py` in the zhizhu repo, which holds the token and the
extraction code. That split is deliberate: the generator is private, this is
public, and no credential ever needs to be here.

Live at https://wuhx.github.io/zhizhu-reader/

## The bundle

```
data/
  head.json              the only mutable file. ~1 KB, served no-cache
  log/000137.json        one build's puts and deletes. immutable
  snapshot/000120.json   every live entry as of that seq. immutable
  articles/Ab3xY9zQ.json one article body. immutable, written once
```

**Nothing published is ever rewritten.** That single rule is why the catalog is
a log rather than a file per publisher or a shard per month: changing one
article would mean rewriting whatever file contains it, on every build, forever.
It is also what RSS cannot do — a channel is rebuilt in full for one new item,
and it has no way to say an article was edited or removed at all.

So a new article costs one ~1 KB append. A metadata edit to a two-year-old
article costs the same ~1 KB append. `git diff` after a build shows the new log,
the new article files, and one line of `head.json`.

### How a client syncs

1. `GET data/head.json`
2. if the local cursor is behind `head.snapshot` (or `epoch` changed), load that
   snapshot and take its seq as the cursor
3. fetch `data/log/{n}.json` for each n after the cursor, applying `put` and
   `del` in order
4. done — in the steady state that is one ~1 KB fetch

The index then lives in IndexedDB, so paging the timeline, filtering by
publisher or tag, sorting and searching are all local. There is no pagination,
no per-feed fetch, and no search index to build or keep in step.

Because every file except `head.json` is immutable, the service worker serves
them cache-first and never revalidates: an article read once is readable offline
forever.

## Publishers, not sources

The sidebar lists **publishers**. A source in zhizhu is crawl configuration —
which spider config found a link — and it is not what anyone subscribes to. The
`mp` source alone stands in for every WeChat account, so grouping by source
would collapse them all into one row.

`publisher` defaults to the source id, so an ordinary blog is its own publisher
and nothing about it changes. The display name comes from `author`, resolved
through `head.json` rather than stored per article — which is what makes a
rename free: the new name arrives with the next article and every past entry
re-labels, with no log rewrite and no change to any feed URL.

## Reading state

Read, starred and the sync cursor live in IndexedDB, on the device. Nothing is
sent anywhere and there is no account. That is a deliberate limit, not an
oversight — it is also why the export/import in the app matters if you read on
more than one machine.

## Working on it

```sh
python3 -m http.server 8899     # then open http://127.0.0.1:8899/
just reader-build               # from the zhizhu repo, to refresh data/
```

No build step, no npm, no framework: three files of app code, served as they
are. The service worker's cache key is stamped at deploy time from a hash of
those files (`.github/workflows/deploy.yml`), so it moves when they do and never
otherwise — a publish must not evict the app shell or the articles already
cached.
