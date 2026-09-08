# zhizhu-reader

The reading front end for the [zhizhu](https://github.com/wuhx/zhizhu) article
archive.

It is an ordinary feed reader. The subscription list is OPML, the content is RSS,
and neither is a private format — this is a feed reader that happens to ship with
zhizhu's feeds, not a client only zhizhu can serve. Everything here is edited by
hand: `index.html`, `sw.js`, `assets/`, `feeds.opml`. There is no build step and
no generator, so nothing about *content* needs a deploy.

Live at https://wuhx.github.io/zhizhu-reader/

## The subscription list

The default is
`https://wuhx.github.io/zhizhu-reader/feeds.opml`. The gear at the bottom-right
of the publisher sidebar opens subscription settings, where that address can be
replaced, restored to the default, or downloaded. A custom address is saved in
the browser and completely replaces the default list; the two are not merged.

An OPML file can point to feeds on any host, but those hosts must allow the
reader's cross-origin requests. An unreachable, malformed, or CORS-blocked feed
does not stop the other publishers from refreshing. Its publisher is marked
with the failure in subscription settings.

Removing an outline drops its articles from the local catalog. Nothing else does
— see the window, below.

## How a refresh works

1. `GET` the configured OPML address
2. for each outline, `GET` the feed with `If-None-Match` from the ETag stored
   last time
3. materialize every item of every feed that actually changed

That is all of it. There is no head, no snapshot, no log and no sequence cursor,
because a feed already carries the full article body in `<content:encoded>` —
so the listing and the reading come down together and opening an article touches
no network at all.

Cold, that is 26 feeds and about **950 KB** for ~280 articles. Warm, every feed
answers **304** and no article body crosses the wire.

Warm still costs 52 round trips rather than 26, because `If-None-Match` is not a
CORS-safelisted header and each conditional GET is preflighted. Chrome would
normally cache the preflight, but the Fetch spec forces cache mode `no-store` for
any request carrying an author-set `If-None-Match`, and Chrome skips the
preflight cache there. Both halves are empty responses, so it costs latency and
no payload.

### The weak-ETag wrinkle

Cloudflare weakens an ETag whenever it gzips a response — which, for a browser,
is always — turning `"98aa…"` into `W/"98aa…"`. But its `If-None-Match`
comparison is an exact string match, not the weak comparison RFC 9110 asks for.
Echo back the tag it just sent and it answers `200` with the whole body.

So `app.js` strips the `W/` before sending it back, which is what actually earns
the 304. Nothing is lost by that: the strong form is the tag the Worker itself
emitted, and a genuinely weak match is exactly the case a feed reader wants to
treat as unchanged anyway.

## The window

A feed carries its publisher's most recent items, not everything that ever
existed, so a fresh device starts with what the feeds currently hold rather than
the whole archive.

An item ageing out of a feed is therefore **not** treated as a deletion — if it
were, the local catalog could never exceed the window. It keeps what it has seen
and adds what arrives, so the archive on a device grows past the feeds over time.
The only thing that removes an article is its outline leaving the effective
OPML list.

## Derived, not carried

The feed has no cover image, no excerpt and no reading estimate. All three fall
out of the body it does carry, and are computed once when an item is
materialized rather than on every render: the excerpt from `<description>` when a
publisher sends one and off the front of the body when it does not, the cover
from the first image in the body, the estimate from its length.

Cover coverage is thinner than it was — the old generator used `og:image`, which
is not in the feed, and plenty of bodies have no image at all. A card without a
thumbnail is a normal card.

## Publishers, not sources

The sidebar lists **publishers**, one row per outline, in the order the effective
OPML file gives them — so the order of the sidebar is something you can edit,
and a new publisher has a row before its first article arrives.

A source in zhizhu is crawl configuration — which spider config found a link —
and it is not what anyone subscribes to. The `mp` source alone stands in for
every WeChat account, so grouping by source would collapse them all into one row.
It correspondingly has no feed of its own.

The display name is the outline's `text`, which means a rename is an edit here
and re-labels every past entry at once, with no change to any feed URL.

## Reading state

Read, starred, the cached OPML, feed failures and per-feed ETags live in
IndexedDB, on the device. The selected OPML address lives in local storage.
Nothing is sent anywhere and there is no account.

Articles are keyed on the feed's `<guid>`, which is stable across a re-archive
and across a change of link, so read and star flags survive both.

## Working on it

```sh
python3 -m http.server 8899     # then open http://127.0.0.1:8899/
```

No build step, no npm, no framework: three files of app code and an OPML file,
served as they are. The feeds are fetched cross-origin from the live Worker,
which allows any origin, so local development needs no proxy.

The service worker's cache key is stamped at deploy time from a hash of the app
files *and* the default `feeds.opml` (`.github/workflows/deploy.yml`), so it moves
when they do and never otherwise. The default list stays a core asset so a deploy
updates readers that have not selected a custom OPML address.
