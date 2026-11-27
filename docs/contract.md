# kimmi build contract

The single source of truth shared by the server, the browser SDK and the dashboard. If an implementation has to deviate, change this file in the same edit and say so in your report.

kimmi is self-hosted session replay with analytics: one Go binary that ingests rrweb recordings and small analytics hits from a browser SDK, stores recordings on local disk or S3-compatible storage, indexes them and the hits in SQLite or PostgreSQL, and serves an embedded React dashboard.

## Repository layout

```
cmd/kimmi/            main: `kimmi serve`, `kimmi admin`, `kimmi loadgen`, `kimmi version`
internal/             all Go packages (config, store, blob, ingest, worker, api, auth, guard, bootstrap, project, notify, webui)
internal/webui/dist/  built dashboard + kimmi.js, embedded with go:embed (a placeholder index.html is committed)
web/                  dashboard (Vite, React 19, Tailwind v4). Builds to web/dist
sdk/browser/          @kimmi/browser (TypeScript, rrweb). Builds ESM + IIFE (dist/kimmi.js)
examples/react-spa/   Vite React app using the SDK from npm-style import
examples/nextjs/      Next.js app using the SDK
docker-compose.yml    postgres + seaweedfs + kimmi
Dockerfile, Makefile, .env.example
```

Go module path: `github.com/dimmihq/kimmi`. Go 1.26. Local ports: server `8700`, dashboard dev server `5210` (proxies `/api`, `/i`, `/kimmi.js` to 8700), React example `5220`, Next.js example `5230`, compose Postgres `25432`, compose SeaweedFS S3 `28333`.

## Configuration

Environment variables only (compose loads `.env`). No config file.

| Variable | Default | Meaning |
|---|---|---|
| `KIMMI_HTTP_ADDR` | `:8700` | Listen address |
| `KIMMI_PUBLIC_URL` | `http://localhost:8700` | Used in snippets and invite links |
| `KIMMI_SECRET` | none, required | Signs session cookies; at least 32 chars |
| `KIMMI_DATABASE_URL` | `sqlite://./data/kimmi.db` | `sqlite://path` or `postgres://...` |
| `KIMMI_STORAGE` | `local` | `local` or `s3` |
| `KIMMI_STORAGE_PATH` | `./data/recordings` | Folder for `local` |
| `KIMMI_S3_ENDPOINT`, `KIMMI_S3_BUCKET`, `KIMMI_S3_REGION`, `KIMMI_S3_ACCESS_KEY`, `KIMMI_S3_SECRET_KEY` | | For `s3`; path-style addressing always |
| `KIMMI_ROLES` | `all` | Comma list of `ingest`, `api`, `worker`, or `all` |
| `KIMMI_SIGNUPS` | `open` | `open` or `closed`. Closed: invite only; one sign-up is allowed only while the instance has no organisation at all |
| `KIMMI_FLUSH_INTERVAL` | `2s` | How often an ingest node writes its buffered blocks |
| `KIMMI_SESSION_IDLE` | `30m` | A session with no data for this long is sealed |
| `KIMMI_LIVE_WINDOW` | `45s` | A session with data newer than this counts as live |
| `KIMMI_OWNER` | none | `email:password`. When the database has no users at start, creates the organisation and this owner. Ignored once any user exists. Never logged; a malformed value or a password outside 8 to 72 characters stops the server |
| `KIMMI_ORG` | `kimmi` | Name of the organisation `KIMMI_OWNER`, `KIMMI_BOOTSTRAP` and `kimmi admin` create when there is none |
| `KIMMI_BOOTSTRAP` | none | Path of a JSON file of projects applied on every start (see Bootstrap) |
| `KIMMI_TRUSTED_PROXIES` | none | Comma list of CIDRs (or addresses) of reverse proxies. `X-Forwarded-For` is believed only when the direct peer is in it; the client is the rightmost address that is not a trusted proxy. Empty: the socket address is always used. Behind a Kubernetes ingress set the pod network, e.g. `10.0.0.0/8` |
| `KIMMI_INGEST_RATE` | `20` | Batches per second per (project, client address) before `429`; `0` disables (load tests) |
| `KIMMI_INGEST_BURST` | `60` | Bucket size for `KIMMI_INGEST_RATE` |
| `KIMMI_AUTH_RATE` | `10` | Attempts per minute per client address on `/auth/login`, `/auth/signup`, `/invitations/accept` and `/me/password` before `429`; `0` disables |
| `KIMMI_AUTH_BURST` | `10` | Bucket size for `KIMMI_AUTH_RATE` |
| `KIMMI_INGEST_BUFFER` | `64MiB` | Most batch bytes an ingest node holds before writing them (past it: `503`). It also caps the batch bodies being read at once |
| `KIMMI_INGEST_PROJECT_BUFFER` | half of `KIMMI_INGEST_BUFFER` | One project's share of the buffer (past it: `503` for that project only) |
| `KIMMI_MEMORY_LIMIT` | `256MiB` | Soft memory limit of the Go runtime (`0`: none). `GOMEMLIMIT`, when set, wins. Not a hard cap: near it the collector works harder |
| `KIMMI_TEST_HOOKS` | none | `1` is for kimmi's own tests and demo data, never production: a hit may say when it happened (`at`), `POST /api/v1/test/clock { offsetMs }` (owner) moves the clock alerts go by, and the alerts that follow the clock are checked every 2 seconds instead of every 5 minutes. A warning is logged at start |
| `KIMMI_DEBUG_ADDR` | none | Serves `net/http/pprof` under `/debug/pprof/` on this separate address (e.g. `127.0.0.1:6060`). Never exposed on the public listener; keep it off the network |

Sizes take a plain byte count or a `KB`/`MB`/`GB` (powers of 1000) or `KiB`/`MiB`/`GiB` suffix. Rate limits are in memory and per process.

## Memory

A node's memory is bounded by its settings, not by its traffic:

- Ingest holds at most `KIMMI_INGEST_BUFFER` of batches waiting to be written (a failed write keeps them, still counted), and reads at most another `KIMMI_INGEST_BUFFER` of request bodies at once (one body of up to 5 MB is always let through). Past either, batches get `503`. Live objects stream to storage from the buffer itself; nothing is copied into one big object first, and S3 uploads are single streamed PUTs.
- Analytics hits count against the same buffer (their body, plus a fixed part per hit and per event) and are written early once 2 MiB of them wait, so a burst of hits gets `503` instead of memory.
- The worker seals one recording at a time, streaming each block event by event; it holds one sealed object of about 8 MiB, one 1 MiB chunk and one event (at most 64 MiB).
- The events endpoint streams block by block, holding one block or one sealed chunk at a time.
- With the defaults a node idles near 20 MB resident and stays under about 150 MB at full ingest speed. The Go runtime's soft limit is `KIMMI_MEMORY_LIMIT`, and a node that goes quiet returns freed memory to the operating system within about 15 seconds.

## Start-up bootstrap and admin commands

Deployments can be fully declarative: no password is ever typed into a terminal.

- `KIMMI_OWNER=email:password` creates the first owner (and the organisation named `KIMMI_ORG`) when the database has no users. Once any user exists it is ignored, whatever its value.
- `KIMMI_BOOTSTRAP=/path/bootstrap.json` is applied on every start, in the single organisation (created with `KIMMI_ORG` when missing):

```json
{ "projects": [ { "name": "production", "slug": "production", "platform": "react",
                  "origin": "https://example.com", "origins": ["https://example.com"],
                  "publicKey": "km_pub_0123456789abcdef",
                  "settings": { "privacy": { "maskAllText": true } } } ] }
```

  `slug` and `publicKey` (`km_pub_` and 16 lowercase hex digits) are required; `origins` and `settings` (a partial `ProjectSettings`, deep-merged over the defaults) are optional; unknown fields are refused. A project whose `publicKey` already exists is left exactly as it is: settings are not re-applied, so dashboard edits survive restarts. A project whose slug exists with a different key stops the server with a message: a key is never changed here. Otherwise the project is created with that fixed key. Restarting with the same file is a no-op. Public keys are not secrets. On PostgreSQL concurrent starters take an advisory lock, so two nodes never create two organisations.
- `kimmi admin project list` prints every project as a JSON array of `{ id, name, slug, platform, origin, origins, publicKey, retentionDays, createdAt }`.
- `kimmi admin project create --name NAME --origin URL --platform PLATFORM [--origins a,b] [--slug SLUG] [--key km_pub_...]` creates a project in the organisation (created with `KIMMI_ORG` when missing) and prints it as one such JSON object. A taken slug or key fails; without `--slug`/`--key` they are generated.
- `kimmi admin token create --name NAME --access read|write [--expires-days N]` creates an API token owned by the organisation's oldest owner and prints it once as `{ id, name, prefix, access, user, createdAt, lastUsedAt, expiresAt, secret }` (`user` is the owner's email). It fails when there is no owner yet. `--expires-days` is 1 to 3650; without it the token never expires.
- `kimmi admin token list` prints every API token in the organisation as a JSON array of the same objects without `secret`.

The admin commands read the same environment as `kimmi serve` and work on the database directly; running ingest nodes see a new project within 5 seconds.

## Data model

Every row carries `org_id`; anything project-scoped carries `project_id`. Ids are UUIDv7 strings. Times are Unix milliseconds (`BIGINT`).

- `orgs(id, name, created_at)`
- `users(id, org_id, name, email unique, password_hash, role owner|admin|member|viewer, preferences json, created_at, last_login_at)`
- `auth_sessions(id, user_id, token_hash, user_agent, ip, created_at, last_seen_at)`
- `invitations(id, org_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at)`
- `api_tokens(id, org_id, user_id, name, prefix, token_hash, access read|write, created_at, last_used_at, expires_at)`
- `projects(id, org_id, name, slug, platform, origin, timezone, public_key unique, origins json, settings json, retention_days, keep_starred, created_at, deleted_at)`
- `project_members(project_id, user_id, role)` (owners and admins see every project)
- `visitors(id, org_id, project_id, anonymous_id, external_id, name, email, traits json, country, country_code, city, device, browser, os, first_seen, last_seen, sessions)` unique on `(project_id, anonymous_id)`
- `sessions(id, org_id, project_id, visitor_id, started_at, last_at, duration_ms, active_ms, pages, entry_path, exit_path, urls json, clicks, keypresses, rage_clicks, dead_clicks, errors, viewport_w, viewport_h, device, browser, os, country_code, city, referrer, release, size_bytes, block_count, last_seq, seen, starred, sealed, sealed_key, sealed_chunks json, deleted_at)` (`last_seq` is the highest block seq received)
- `blocks(session_id, seq, project_id, file_key, offset, length, first_ts, last_ts, created_at)` live tier only; rows are deleted when the session is sealed
- `usage_daily(project_id, day, sessions, bytes)`
- `visits(id, org_id, project_id, visitor_key, started_at, last_at, pageviews, actions, engaged_ms, entry_path, exit_path, referrer, channel, utm_source, utm_medium, utm_campaign, country_code, device, browser, os, language, viewport_w, release, is_returning, cookieless)` one row per visit, recorded or not. A recorded visit has the id of its session. `visitor_key` is `a:` and the anonymous id, or `h:` and the day's cookieless hash. `referrer` is a host (or the `utm_source` when there is no referrer); `channel` is `Direct`, `Search`, `Social`, `AI`, `Email`, `Paid`, `Referral` or `Campaign`
- `events(id, org_id, project_id, visit_id, ts, kind, path, name, label, value, x, y, w, num, props json)` the event index: see Events of a hit
- `notes(id, org_id, project_id, session_id, user_id, at_ms, body, created_at)`
- `shares(id, org_id, project_id, kind recording|dashboard, session_id, start_ms, token_hash unique, created_by, created_at, expires_at)`
- `feedback(id, org_id, project_id, visit_id, visitor_key, path, body, email, created_at, seen)`
- `stats_daily(project_id, day, dim, k, visits, pageviews, bounces, duration_ms, new_visitors, time_ms, scroll_sum, scroll_n, exits, sketch)`, `events_daily(project_id, day, kind, name, path, n, visits, value, aux, num, first_ts, last_ts, label, props, last_visit)`, `heat_daily(project_id, day, path, device, x, y, n)`, `funnel_daily(project_id, day, funnel_id, step, visits)`, `funnel_visits(visit_id, funnel_id, project_id, day, step)`, `known_visitors(project_id, visitor_key, first_week, weeks)`, `cohort_weekly(project_id, cohort, week, visitors)`: what the analytics pages read (see Daily tables)
- `salts(day, salt)` the secret of each day's cookieless hashes; only today's is kept
- `project_state(project_id, name, value, updated_at)` when an alert last fired, which week's digest was sent

Postgres: `sessions` is partitioned by day on `started_at`; retention drops whole partitions where every project agrees, and deletes by project otherwise. SQLite: same logical tables, no partitions. One `Store` interface, two implementations, one conformance test suite run against both.

### Storage tiers

1. **Live.** The ingest handler never decompresses the events. It copies each batch's compressed bytes into an in-memory buffer (bounded by `KIMMI_INGEST_BUFFER`, past which batches get `503`) and, every `KIMMI_FLUSH_INTERVAL` or as soon as 8 MiB (at most a quarter of the buffer) wait, streams one object `live/{yyyy-mm-dd}/{node}-{unixms}.bin` holding all buffered blocks back to back, then inserts `blocks` rows (file key, offset, length) and upserts the `sessions` rows from the batch metadata. A graceful shutdown flushes first.
2. **Sealed.** The worker finds sessions idle longer than `KIMMI_SESSION_IDLE`, reads their blocks in `seq` order, streams each one through gunzip event by event (one session and one sealing run at a time; a single event over 64 MiB is refused), re-encodes the session as zstd chunks of about 1 MB split on event boundaries, appends them to a per-project object `sealed/{retentionDays}d/{projectId}/{yyyy-mm-dd}/{uuid}.bin` (one new object per project per sealing run, closed at about 8 MiB and continued in another, since S3 objects cannot be appended to and the object is built in memory; chunks close at block boundaries, and only a single block over 1 MB is split between events), stores `sealed_key` and `sealed_chunks` (offset, length, first_ts, last_ts, events, first_seq, last_seq) on the session, and deletes its `blocks` rows. Live objects with no remaining blocks are deleted.
3. **Cleanup.** Nightly (and on demand): sessions past their project's retention are marked deleted and their sealed objects removed when no live session references them.

### Daily tables

The analytics pages do not sum visits and events when they are opened: that would slow down with traffic. Every flush of hits also adds to the daily tables, in its own transaction, and the pages read those: a few rows per day and value, whatever the volume.

- A day is the project's own day (its time zone when the visit arrived), by the visit's start.
- `stats_daily` holds, per day, dimension (`all`, `source`, `channel`, `campaign`, `entry`, `exit`, `country`, `device`, `browser`, `os`, `language`, `page`, and the one-row `returning` and `known`) and value, the sums and a sketch of the distinct visitors. A sketch keeps visitors one by one while they are few (2,048 for the totals, 128 for a breakdown row) and is a HyperLogLog estimate beyond: unique visitors are then right to about 1% for totals and 3% for a breakdown row. Visits, page views, bounces and every other count are exact.
- `events_daily` holds, per day, kind, name and path, how often and in how many visits, and the latest occurrence. Web vitals are counted in 10% steps with their sum, so a 75th percentile is right to within a few percent.
- A funnel is counted as visits come in: `funnel_visits` keeps how far each visit got, `funnel_daily` how many reached each step. A funnel that is new, or whose steps changed (it then gets a new id), is counted over the stored visits in the background right after the settings are saved.
- Cohorts are kept per visitor with a lasting identity (`known_visitors`) and summed in `cohort_weekly`, whatever order visits arrive in. "Active today, in 7 days, in 30 days" are calendar days of the project.
- A report narrowed to some visits (one source, one page, one country) cannot be answered from sums and reads the visits and events of the window; so does the list of a group's occurrences.
- Erasing a visitor counts the days they were seen on again from the remaining visits, and takes them out of the cohorts and funnels.

### What is kept how long, and what erasing removes

- Recordings follow `retention.days`. Visits, events and feedback follow `analytics.retentionDays` (30, 90, 365 or 730; default 365), so trends outlive recordings. The nightly cleanup removes both.
- Deleting a recording (by hand or by retention) removes its notes and its public links. Its visit and events stay until the analytics retention passes: they hold no page content.
- Erasing a visitor (`DELETE /visitors/{vid}`, `POST /visitors/erase`) removes their visits, events, feedback, and the notes and links of their recordings, in the same transaction as the recordings.
- Deleting a project removes all of it.

The blob interface has two drivers, `local` and `s3`, with `Put`, `Get(key, offset, length)`, `Delete`, `List(prefix)`.

## Ingest protocol (SDK to server)

CORS: any origin, no credentials. A project's `origins` list, when not empty, is enforced against the `Origin` header (403).

### `GET /i/v1/config?key={publicKey}`

```json
{
  "recording": true,
  "sampleRate": 100,
  "privacy": { "maskAllText": false, "maskAllInputs": true, "blockMedia": false, "recordCanvas": false,
               "maskSelectors": [], "blockSelectors": [], "ignoreSelectors": [],
               "respectDnt": false, "requireConsent": false, "ip": "truncate",
               "scrubEmails": true, "scrubPhones": true },
  "capture": { "console": true, "network": true, "networkBodies": false, "performance": true,
               "frustration": true, "crossOriginIframes": false, "startOnError": false,
               "minDurationMs": 2000, "idleTimeoutMs": 900000, "maxLengthMs": 3600000,
               "urlRules": [ { "type": "contains", "pattern": "/checkout" } ] },
  "analytics": { "enabled": false, "cookieless": false, "autoEvents": true, "heatmaps": true },
  "feedback": { "button": "hidden" }
}
```

`recording: false` (unknown key, quota, project deleted) means the SDK does nothing. With `scrubEmails` and `scrubPhones` (both default `true`; settings stored without them read as `true`), emails and phone numbers in console, network, error and URL text are replaced in the browser before sending. These same `privacy` and `capture` objects are the project settings the dashboard edits.

### `POST /i/v1/batch?key={publicKey}`

Binary body, sendable with `fetch(keepalive)` or `navigator.sendBeacon`:

```
4 bytes   big-endian uint32 N
N bytes   UTF-8 JSON metadata (not compressed)
rest      gzip of a JSON array of rrweb events (the server stores these bytes untouched)
```

Metadata:

```json
{
  "v": 1,
  "sessionId": "uuid", "windowId": "uuid", "seq": 0,
  "anonymousId": "uuid kept in localStorage",
  "identity": { "id": "user-42", "email": "a@b.c", "name": "Ada", "traits": {} },
  "startedAt": 1795750000000, "firstTs": 1795750000000, "lastTs": 1795750004000,
  "url": "https://shop.acme.dev/checkout", "path": "/checkout", "referrer": "https://google.com/",
  "viewport": { "w": 1440, "h": 900 },
  "language": "en-GB", "timezone": "Africa/Lagos", "release": "v4.18.2",
  "counts": { "events": 120, "clicks": 3, "keypresses": 14, "rageClicks": 0, "deadClicks": 0,
              "errors": 0, "pageviews": 1, "activeMs": 3200 },
  "paths": ["/checkout"]
}
```

`seq` starts at 0 and increases by one per batch within a session. `startedAt` must be the same in every batch of a session. `counts`, `paths` and `pageviews` describe this batch only (the server sums them); `paths` lists the paths visited during the batch and `path` is the current one. `identity` is optional. Responses: `204` stored; `400` malformed; `403` origin not allowed or key unknown (SDK stops); `413` over 5 MB; `429` over quota or over the per (project, address) rate limit `KIMMI_INGEST_RATE`, with `Retry-After` in seconds (the SDK stops for the session); `503` the server is behind on writes, its buffer for the node or the project is full, or too many bodies are being read at once, with `Retry-After` (retry later). A batch body must arrive within 30 seconds. A `GET /i/v1/config` with an unknown key answers `200` with `recording: false`; a known key from a refused origin answers `403`. Origin entries may use a wildcard subdomain: `https://*.acme.dev`. The server reads device, browser and OS from the `User-Agent` header, and derives `country_code`, country and city from `timezone` with a small embedded IANA-zone table (no IP database). The IP is used only for rate limiting, stored according to `privacy.ip`.

### `POST /i/v1/hit?key={publicKey}`

Analytics travel apart from recordings, as small JSON, so they flow for visits that are not recorded (sampling, URL rules, no consent) and the server never decompresses a recording to count something. Body: JSON text of at most 64 KB, sent as `text/plain` with `fetch(keepalive)` or `navigator.sendBeacon`:

```json
{ "v": 1, "visitId": "uuid", "anonymousId": "uuid, or empty", "startedAt": 1795750000000,
  "url": "https://shop.acme.dev/pricing", "landing": "https://shop.acme.dev/?utm_source=news", "referrer": "https://google.com/",
  "viewport": { "w": 1440, "h": 900 }, "language": "en-GB", "timezone": "Africa/Lagos", "release": "v4.18.2",
  "events": [ { "t": 1795750000123, "k": "page", "p": "/pricing", "l": "Pricing" } ] }
```

`visitId` is the recording's session id while one is running, so a visit and its recording share an id. `landing` is the visit's first URL; the server reads `utm_source`, `utm_medium`, `utm_campaign` and paid click ids from it, and the source from `referrer` (a referrer on the site's own host is not a source). At most 200 events a hit. Responses: `204` stored; `400` malformed; `403` key unknown, origin refused or analytics off for the project (the SDK stops); `413` too large; `429` rate limited, sharing the batch limit; `503` buffer full. Hits are buffered and written with each flush, in one transaction per flush.

A hit with an empty `anonymousId` is cookieless: the server names the visitor `sha256(salt of the UTC day | project | client address | User-Agent)`, cut to 128 bits. The salt is random, stored only for its day and deleted the next, so the hash cannot be redone later and a returning visitor counts again the next day. Hits of one such visitor at most 30 minutes apart are one visit. The address is not stored.

#### Events of a hit

Keys: `t` time in ms, `k` kind, `p` path, `n` name, `l` label, `v` number, `x` `y` `w` `num` integers, `d` a small object. Unknown kinds are dropped.

| `k` | meaning |
|---|---|
| `page` | a page view: on load and on every route change; `l` is the title |
| `leave` | leaving a page (next page, tab hidden, page closed): `v` engaged ms since the last `leave`, `num` deepest scroll in percent, `y` page height, `w` viewport width. Several may follow one page view: `v` adds up, `num` is the maximum |
| `track` | `kimmi.track(name, props)`: `n` name, `d` props, `v` the `value` or `revenue` prop. Automatic events are `$outbound` (`d.url` host and path), `$download` (`d.file`), `$email`, `$phone`, `$form` (`d.form`, `d.action`) |
| `error` | an uncaught error: `l` message, `d` `{ source, stack }`. The server groups by a fingerprint of the message (numbers flattened) and the first stack frame without line and column |
| `rage`, `dead` | rage click and dead click: `n` selector, `l` element text, `v` clicks (rage). Only while recording |
| `click` | for heatmaps: `n` selector, `l` text, `x` in 1/10000 of the page width, `y` page pixels, `w` viewport width |
| `request` | a fetch or XHR that failed (`status` 0 or 400 and above) or took 3 s or more: `n` `METHOD host/path`, `v` ms, `num` status |
| `vital` | once per page load: `n` `lcp`, `inp`, `cls`, `fcp` or `ttfb`, `v` the value |

### `POST /i/v1/feedback?key={publicKey}`

`{ "v": 1, "visitId", "anonymousId", "path", "text", "email" }` as `text/plain` JSON, at most 8 KB. `text` is required (2000 characters are kept), `email` optional. `204` stored; otherwise as for a hit.

### Events inside a batch

Standard rrweb 2.x events, plus rrweb custom events (`type: 5`) with these tags:

| tag | payload |
|---|---|
| `navigate` | `{ href, path, title }` on load and on every SPA route change |
| `console` | `{ level: "log"|"info"|"warn"|"error", text, source }` |
| `network` | `{ method, url, status, ms, size, kind: "fetch"|"xhr" , requestBody?, responseBody? }` |
| `error` | `{ message, source, stack }` uncaught errors and unhandled rejections |
| `rage-click` | `{ selector, text, count }` three or more clicks on one element within 700 ms |
| `dead-click` | `{ selector, text }` a click on an interactive-looking element followed by no DOM change, navigation or network request within 1.5 s |
| `identify` | `{ id, email, name }` |
| `track` | `{ name, props }` from `kimmi.track`, so the player can show it |

### SDK surface (`@kimmi/browser`)

```ts
kimmi.init({ key: 'km_pub_...', host: 'http://localhost:8700', release?: string,
             scrub?: (text: string) => string /* runs on console, network, error and URL text before sending */ })
kimmi.identify(id: string, traits?: { email?: string; name?: string; [k: string]: unknown })
kimmi.optIn(); kimmi.optOut(); kimmi.stop(); kimmi.getSessionId(): string | null
kimmi.track(name: string, props?: Record<string, unknown>)   // a `value` or `revenue` number is summed in reports
kimmi.feedback(text: string, options?: { email?: string })
kimmi.showFeedback(position?: 'bottom-right' | 'bottom-left') // loads {host}/kimmi-feedback.js and shows the button
```

Analytics are off until a project turns them on (`analytics.enabled`, default `false`): a project that only records sends no hits, and its dashboard shows no analytics pages. `Project.analytics` in the dashboard API says which it is. Analytics start when `analytics.enabled`, independently of `sampleRate`, `urlRules`, `minDurationMs` and `startOnError`. A visit is named, in order: by the running recording session; when `analytics.cookieless`, by nothing kept in the browser (an id in memory for the page load, an empty `anonymousId`); otherwise by the anonymous id in `localStorage` and a visit in `sessionStorage` (`kimmi.visit`, 30 minutes of inactivity), when consent allows storage. `optOut()` and Do Not Track (with `privacy.respectDnt`) stop analytics too. With `analytics.cookieless` the recorder waits for `kimmi.optIn()` as if `privacy.requireConsent` were on, and nothing is written to `localStorage` or `sessionStorage` before that. Every string in a hit goes through the same scrubbing as console, network and error text; click text of a masked element is empty; link targets of `mailto:` and `tel:` are never sent.

Script tag: `<script src="{host}/kimmi.js" data-key="km_pub_..." defer></script>` auto-inits and exposes `window.kimmi`. Flush every 2 s and on `visibilitychange`/`pagehide` (beacon). Session id and seq live in `sessionStorage`; a session ends after `idleTimeoutMs` without activity or at `maxLengthMs`, and a new one starts with a fresh full snapshot.

## Dashboard API

Base `/api/v1`. JSON. Auth: cookie `kimmi_session` (HttpOnly, SameSite=Lax) set by login/signup, or `Authorization: Bearer km_sec_...` for API tokens. Errors: `{ "error": { "code": "invalid", "message": "Email is already in use", "fields": { "email": "Already in use" } } }` with 400/401/403/404/409. Mutations return the updated resource unless noted. Roles: viewer reads; member reads and stars/deletes recordings; admin changes project settings and members; owner does everything.

### Auth and account

| Method and path | Body | Returns |
|---|---|---|
| `GET /auth/status` (public) | | `{ signups: "open"|"closed", hasUsers: boolean }` |
| `POST /auth/signup` | `{ name, email, password, orgName? }` | `{ user, org }` creates a new org with this user as owner |
| `POST /auth/login` | `{ email, password }` | `{ user, org }` |
| `POST /auth/logout` | | 204 |
| `GET /auth/me` | | `{ user, org }` or 401 |
| `PATCH /me` | `{ name?, email? }` | `User` |
| `POST /me/password` | `{ current, next }` | 204 |
| `GET /me/sessions` | | `AuthSession[]` |
| `DELETE /me/sessions/{id}` | | 204 |
| `GET /me/preferences`, `PUT /me/preferences` | free-form JSON object | the object |

`User = { id, name, email, role, createdAt, lastLoginAt }`, `Org = { id, name }`, `AuthSession = { id, browser, os, ip, createdAt, lastSeenAt, current }`.

### Team and tokens

| Method and path | Body | Returns |
|---|---|---|
| `GET /members` | | `User[]` |
| `PATCH /members/{id}` | `{ role }` | `User` |
| `DELETE /members/{id}` | | 204 |
| `GET /invitations` | | `Invitation[]` pending only |
| `POST /invitations` | `{ email, role }` | `{ invitation, link }` |
| `DELETE /invitations/{id}` | | 204 |
| `GET /invitations/lookup/{token}` (public) | | `{ email, orgName, role }` or 404 |
| `POST /invitations/accept` (public) | `{ token, name, password }` | `{ user, org }` and logs in |
| `GET /tokens` | | `ApiToken[]` |
| `POST /tokens` | `{ name, access: "read"|"write", expiresInDays: number|null }` | `{ token: ApiToken, secret }` |
| `DELETE /tokens/{id}` | | 204 |

`Invitation = { id, email, role, createdAt, expiresAt, link }`, `ApiToken = { id, name, prefix, access, createdAt, lastUsedAt, expiresAt }`.

### Projects

| Method and path | Body | Returns |
|---|---|---|
| `GET /projects` | | `Project[]` with `stats` |
| `POST /projects` | `{ name, origin, platform }` | `Project` |
| `GET /projects/{id}` | | `Project` |
| `PATCH /projects/{id}` | `{ name?, slug?, timezone?, platform?, origin? }` | `Project` |
| `DELETE /projects/{id}` | | 204 |
| `POST /projects/{id}/rotate-key` | | `Project` |
| `PUT /projects/{id}/origins` | `{ origins: string[] }` | `Project` |
| `GET /projects/{id}/settings` | | `ProjectSettings` |
| `PATCH /projects/{id}/settings` | partial `ProjectSettings` (deep-merged) | `ProjectSettings` |
| `GET /projects/{id}/members` | | `ProjectMember[]` |
| `POST /projects/{id}/members` | `{ userId, role }` | `ProjectMember` |
| `PATCH /projects/{id}/members/{userId}` | `{ role }` | `ProjectMember` |
| `DELETE /projects/{id}/members/{userId}` | | 204 |
| `POST /projects/{id}/delete-recordings` | `{ olderThanDays?: number }` (omitted: all) | `{ deleted: number }` |

```ts
Project = { id, name, slug, platform, origin, timezone, publicKey, origins: string[], retentionDays, createdAt, analytics: boolean,
            stats: { recordings24h, live, avgDurationMs, storageBytes, recordings, series: number[] /* 30 daily counts, oldest first */, lastRecordingAt: number|null } }
ProjectSettings = { privacy: {...as in /i/v1/config, including scrubEmails and scrubPhones}, capture: {...as in /i/v1/config, plus sampleRate}, retention: { days: 7|30|90|365, keepStarred: boolean },
                    analytics: { enabled, cookieless, autoEvents, heatmaps: boolean, retentionDays: 30|90|365|730, goals: Goal[] /* at most 20 */, funnels: Funnel[] /* at most 10 */ },
                    feedback: { button: "hidden"|"bottom-right"|"bottom-left" /* default hidden */ },
                    alerts: { webhookUrl, secret: string, newErrors: boolean, errorSpike, rageSpike: number /* in an hour; 0 is off */, noTraffic, feedback, weeklyDigest: boolean },
                    sharing: { enabled: boolean } }
Step = { kind: "page"|"event", value: string }   // a path, or a prefix ending in *; or a tracked event's name
Goal = Step & { id, name }                        // send id "" for a new one
Funnel = { id, name, steps: Step[] /* 2 to 6 */ }
ProjectMember = { userId, name, email, role, lastActiveAt }
platform = "react" | "next" | "vue" | "astro" | "svelte" | "script"
```

### Recordings

| Method and path | Returns |
|---|---|
| `GET /projects/{id}/overview?days=7|14|30` | `Overview` |
| `GET /projects/{id}/recordings?view=&q=&duration=&device=&rage=&errors=&visitor=&page=&limit=` | `{ items: Recording[], total, counts: { all, unwatched, friction, starred } }` |
| `GET /projects/{id}/recordings/{rid}` | `Recording & { newerId: string|null, olderId: string|null }` |
| `GET /projects/{id}/recordings/{rid}/events?after={seq}` | `{ events: RrwebEvent[], lastSeq: number, complete: boolean }` |
| `PATCH /projects/{id}/recordings/{rid}` body `{ starred?, seen? }` | `Recording` |
| `DELETE /projects/{id}/recordings/{rid}` | 204 |
| `GET /projects/{id}/live` | `Live` |

Query values: `view` = `all|unwatched|friction|starred`; `duration` = `any|short|medium|long` (under 1 min, 1 to 5 min, over 5 min); `device` = `any|Desktop|Mobile|Tablet`; `rage=1`, `errors=1`; `page` is 0-based; `limit` default 25.

`events?after=-1` returns everything stored so far (sealed chunks, then live blocks), decoded and concatenated in order; `after=n` returns only blocks with `seq > n`. `complete` is true once the session is sealed or has had no data for `KIMMI_LIVE_WINDOW`; a client watching a live session polls with the last `lastSeq` every 2 s until `complete`. For a sealed session `lastSeq` is the last block seq it had. The response is gzip-encoded when the client accepts it.

```ts
Visitor = { id, name: string|null, email: string|null, anonymousId, externalId: string|null, country, countryCode, city,
            device: "Desktop"|"Mobile"|"Tablet", browser, os, firstSeen, lastSeen, sessions }
Recording = { id, projectId, visitor: Visitor, startedAt, lastAt, durationMs, activeMs, pages, entry, exit, currentPath,
              clicks, keypresses, rageClicks, deadClicks, errors, viewport: "1440 × 900", sizeBytes,
              seen, live, starred, release: string|null, referrer: string|null }
Overview = { totals: { recordings, today, avgDurationMs, avgActiveMs, frictionSessions, errorSessions, trendPercent },
             days: { date: "2026-11-27", clean, friction, errors }[],
             topPages: { path, views, rage }[], devices: { name, count }[], countries: { code, name, count }[] }
Live = { visitors, activeLast5m, pages: { path, count }[], countries: { code, name, count }[], sessions: Recording[] }
```

`GET /recordings` also takes `sort=score` (most worth watching first: errors, rage and dead clicks, pages and activity) and one value each of `entry`, `exit`, `path`, `country` (code), `browser`, `os`, `release` (read from the recording), `referrer` (a host, or `Direct`), `channel`, `utmSource`, `utmCampaign`, `language` (read from its visit), and `event=kind:name` with an optional `eventPath` (`error:<fingerprint>`, `rage:<selector>`, `dead:<selector>`, `track:<name>`, `request:<name>`). Every row of the analytics routes links to the list with one of these.

### Analytics

All under `/projects/{id}`, for viewers and above. `days` is `1`, `7` (default), `14`, `30` or `90`; the window ends now and starts at a day boundary of the project's time zone. Visit filters, one value each: `path` (a visit that viewed it), `entry`, `exit`, `referrer`, `channel`, `utmSource`, `utmCampaign`, `country`, `device`, `browser`, `os`, `language`.

| Method and path | Returns |
|---|---|
| `GET /analytics?days=&goal=` + visit filters | `Traffic` |
| `GET /events?days=` | `{ name, count, visits, value }[]` tracked events |
| `GET /errors?days=` | `ErrorGroup[]` most visits affected first |
| `GET /errors/{fingerprint}?days=` | `{ group: ErrorGroup, occurrences: Occurrence[] /* latest 50 */ }` or 404 |
| `GET /friction?days=` | `{ pages: { path, visits, rage, dead, errors }[], elements: { kind: "rage"|"dead", path, selector, label, count, visits, visitId, ts }[] }` |
| `GET /requests?days=` | `{ name, count, failed, visits, avgMs, status, visitId, ts, lastSeen }[]` |
| `GET /vitals?days=` | `{ path, samples, lcp, inp, cls, fcp, ttfb }[]` 75th percentiles; `path: ""` first, for the whole site; `-1` was never measured |
| `GET /funnels?days=` | `{ id, name, steps: (Step & { visits, dropped, watchable })[] }[]` |
| `GET /funnels/{fid}/dropoffs?step=&days=` | `{ items: Recording[], visits }` recordings of visits that reached the step (0 is the first) and not the next |
| `GET /heatmaps?days=` | `{ path, count }[]` pages with clicks |
| `GET /heatmap?path=&device=Desktop|Tablet|Mobile&days=` | `Heatmap` |
| `GET /retention` | `{ daily, weekly, monthly, cohorts: { week, size, active: number[] }[] }` 8 weekly cohorts, oldest first |
| `GET /releases?days=` | `{ release, firstSeen, lastSeen, sessions, errors, friction }[]` among recordings |
| `GET /accounts` | `{ domain, people, sessions, lastSeen }[]` identified visitors by the domain of their email; personal mail domains are left out |

```ts
Traffic = { totals: Totals, previous: Totals, days: { date, visitors, visits, pageviews }[],
            sources, channels, campaigns, entryPages, exitPages, countries, devices, browsers, systems, languages: { name, visitors, visits }[] /* top 10 */,
            pages: { path, views, visitors, avgTimeMs, exits, scroll }[] /* top 20 */,
            goals: (Goal & { conversions })[], goalSources: { name, count }[] /* for ?goal= */ }
Totals = { visitors, visits, pageviews, bounces, avgDurationMs, newVisitors, returning }
ErrorGroup = { fingerprint, message, source, count, visits, firstSeen, lastSeen, path }
Occurrence = { visitId, ts, path, label, props, browser, os, release, recorded, startedAt }   // recorded: recording visitId exists; open it at ts - startedAt
Heatmap = { clicks, cells: { x /* percent of the page width */, y /* steps of 10 px */, n }[], elements: { selector, label, count }[],
            views, scroll: number[10] /* views that reached 10% ... 100% */, height, width, snapshot: { recordingId, ts, startedAt } | null }
```

- A bounce is a visit with one page view, no click or tracked event, and under 10 s engaged.
- A funnel counts visits that did its steps in order within the window; one event advances at most one step.
- Heatmap device classes go by viewport width: Mobile under 768, Tablet under 1024, Desktop from there. `snapshot` names a recording that shows the page, already masked in the browser, to draw under the map.
- Cohorts and the active counts leave out cookieless visitors, who get a new identity every day.

### Notes, public links, feedback, alerts

| Method and path | Body | Returns |
|---|---|---|
| `GET /projects/{id}/recordings/{rid}/notes` | | `Note[]` by time in the recording |
| `POST /projects/{id}/recordings/{rid}/notes` | `{ atMs, body }` | `Note` (member) |
| `DELETE /projects/{id}/recordings/{rid}/notes/{nid}` | | 204 (member) |
| `GET /projects/{id}/shares` | | `Share[]` live links (admin) |
| `POST /projects/{id}/shares` | `{ kind: "recording"|"dashboard", recordingId?, startMs?, expiresInDays: 1|7|30 }` | `Share & { link }` (admin); `403` while `sharing.enabled` is false |
| `DELETE /projects/{id}/shares/{sid}` | | 204 (admin) |
| `GET /shared/{token}` (public) | | `{ kind, project, expiresAt, startMs, recording?: { startedAt, durationMs, viewport, pages, device, browser, os, live } }` |
| `GET /shared/{token}/events?after=` (public) | | `{ events, lastSeq, complete }` for a recording link, with `events` cut down to an allow-list (below) |
| `GET /shared/{token}/analytics?days=` (public) | | the fields of `Traffic` and nothing else, for a dashboard link |
| `GET /projects/{id}/feedback?page=&limit=` | | `{ items: Feedback[], total, unseen }` newest first |
| `PATCH /projects/{id}/feedback/{fid}` | `{ seen }` | 204 (member) |
| `DELETE /projects/{id}/feedback/{fid}` | | 204 (member) |
| `POST /projects/{id}/alerts/test` | | 204, or `400` with why the webhook refused (admin) |
| `POST /projects/{id}/alerts/digest` | | 204: sends the weekly digest now (admin) |

`Note = { id, recordingId, userId, author, atMs, body, createdAt }`, `Share = { id, kind, recordingId, startMs, createdBy, author, createdAt, expiresAt }`, `Feedback = { id, visitId, path, body, email, createdAt, seen, recorded, startedAt }`.

- Public links are off until an admin sets `sharing.enabled`. The link is `{KIMMI_PUBLIC_URL}/shared/{token}`; the token is shown once and only its hash is stored. A link answers `404` once it expires or is revoked, when its recording or project is deleted, and while `sharing.enabled` is false. A recording link shows the replay and nothing about the visitor.
- What a public link returns is an allow-list written out in the server, so a field added to a signed-in answer never reaches one. `events` holds only rrweb's own playback events (types 0 to 4: load, snapshots, incremental changes, meta) and kimmi's `navigate` event rebuilt as `{ href, path, title }`; `console`, `network`, `error`, `rage-click`, `dead-click`, `identify` and `track` events, plugin events and unknown types are never sent. The link itself returns `kind`, `project` (its name), `expiresAt`, `startMs` and, for a recording, `recording: { startedAt, durationMs, viewport, pages, device, browser, os, live }`: no visitor, no identity, no place, no ids. A dashboard link returns counts only: no row is about one visitor, and there is no recording, visit, error or feedback in it.
- Alerts go to one webhook per project (`alerts.webhookUrl`; nothing is sent without one): `POST` with `Content-Type: application/json`, `X-Kimmi-Event`, and `X-Kimmi-Signature: sha256=<hex HMAC-SHA256 of the body with alerts.secret>` when a secret is set. Body: `{ event, project: { id, name }, at, title, text, url, data }`. Events: `error.new` (a fingerprint the project has not seen), `error.spike` and `rage.spike` (the last hour reached the threshold; at most once an hour), `traffic.none` (no visit for 24 hours; at most once a day), `feedback.new`, `digest.weekly` (Monday from 08:00 in the project's time zone: the last seven days), `test`. A delivery times out after 5 seconds, follows no redirect and is not retried. `GET /settings` shows `webhookUrl` as `hidden` and `secret` as empty to anyone below admin.

### MCP

`POST /mcp` speaks the Model Context Protocol (streamable HTTP, one JSON response per JSON-RPC request; `GET /mcp` answers `405`), authenticated like the API with `Authorization: Bearer km_sec_...`. It only reads. Tools: `list_projects`, `get_traffic`, `list_events`, `list_errors`, `get_error`, `get_friction`, `list_funnels`, `get_performance`, `list_recordings`, `list_feedback`; each project tool takes `project` (id or slug) and `days`.

### Visitors

| Method and path | Returns |
|---|---|
| `GET /projects/{id}/visitors?q=&kind=all|identified|anonymous&sort=lastSeen|sessions|firstSeen&page=&limit=` | `{ items: Visitor[], total, counts: { all, identified, anonymous } }` |
| `GET /projects/{id}/visitors/{vid}` | `{ visitor: Visitor, stats: { sessions, totalDurationMs, rageClicks, errors }, activity: { date, count }[] /* last 84 days */, recordings: Recording[] }` |
| `DELETE /projects/{id}/visitors/{vid}` | 204, removes the visitor and all their recordings |
| `POST /projects/{id}/visitors/erase` body `{ query }` (visitor id, external id or email) or `{ externalIdPrefix }` | `{ deleted: number }` |

### Instance

| Method and path | Returns |
|---|---|
| `GET /storage` | `{ totalBytes, recordings, projects: { id, name, platform, bytes, recordings, retentionDays }[], ages: { label, bytes, expiringBytes }[], nextCleanupFreesBytes }` |
| `POST /storage/cleanup` | `{ freedBytes, deleted }` runs retention now |
| `GET /instance` | `{ version, commit, startedAt, roles: string[], database: { driver, version }, storage: { driver, location }, publicUrl, health: { name, status: "healthy"|"degraded"|"down", detail }[] }` |

### Server behaviour the dashboard can rely on

- Creating something (`signup`, `invitations/accept`, `POST /projects`, `/invitations`, `/tokens`, `/projects/{id}/members`) answers `201`; other successes `200` or `204`.
- Extra error codes: `401 invalid_credentials` (login), `403 forbidden` (role or read-only token, closed sign-ups), `409 conflict` (email, slug), `409 last_owner` (the last owner cannot be demoted or removed), `429 rate_limited` with `Retry-After` (too many attempts on `/auth/login`, `/auth/signup`, `/invitations/accept`, `/me/password` from one address).
- A login with an unknown email costs the same bcrypt comparison as one with a wrong password, so response times do not reveal which emails have accounts.
- `GET /auth/status` reports `hasUsers: true` when users exist, and also, with `KIMMI_SIGNUPS=closed`, when an organisation exists without users (one bootstrapped from `KIMMI_BOOTSTRAP`), so the dashboard shows the login page and a stranger cannot claim it.
- Routes and roles. Viewer: every `GET`, and `PATCH .../recordings/{rid}` with `seen` only. Member: also star, delete recordings, delete and erase visitors. Admin: create projects, change project settings, origins, keys and project members, `delete-recordings`, invitations, org members (not owners), `POST /storage/cleanup`. Owner: also delete projects and manage owners. Everyone manages their own `/me`, sessions and `/tokens` (tokens are per user; a `read` token can only `GET`).
- Project roles (`project_members.role`) are `admin`, `member` or `viewer`; a member's or viewer's effective role in a project is the lesser of their org role and their project role. Projects they are not added to answer `404`.
- `view=friction` and `counts.friction` mean rage clicks, dead clicks or errors; `Overview.totals.frictionSessions` counts rage or dead clicks and `errorSessions` counts errors. In `Overview.days` a recording with errors counts as `errors`, else with rage or dead clicks as `friction`, else `clean`. `topPages.views` counts recordings that visited the path.
- Daily buckets (`stats.series`, `Overview.days`, visitor `activity`) follow the project's `timezone`.
- `Live.visitors` counts visitors with data in `KIMMI_LIVE_WINDOW`; `activeLast5m` in the last 5 minutes.
- `GET /storage` covers the projects the caller can see. `ages` labels: `Last 7 days`, `8–30 days`, `31–90 days`, `91–365 days`, `Older than a year`; `expiringBytes` passes retention within 7 days; `nextCleanupFreesBytes` is past retention or already deleted. `POST /storage/cleanup` returns `freedBytes` as the object bytes actually removed (a packed sealed object goes once no recording points to it) and `deleted` as recordings removed.
- `POST /visitors/erase` returns the number of visitors deleted. With `externalIdPrefix` it erases every visitor of the project whose external id starts with it, compared literally and case-sensitively (`%` and `_` are not wildcards), with their recordings, as `query` does. The prefix must be at least 3 characters and end with `:`, else `400` with `fields.externalIdPrefix`; sending both `query` and `externalIdPrefix` is also a `400`. Like any write it needs a member or above, and a `write` token.
- `events?after=n` on a sealed session returns the chunks whose `last_seq > n`; a chunk holding several blocks is sent whole.
- A batch that arrives for a sealed session reopens it; the next sealing run packs the old chunks and the new blocks together.

## Static

`/kimmi.js` serves the SDK IIFE bundle and `/kimmi-feedback.js` the feedback button, loaded only when a site shows it (5-minute cache each). Every response carries `X-Content-Type-Options: nosniff`, and `Strict-Transport-Security: max-age=31536000` when `KIMMI_PUBLIC_URL` is https (cookies are then `Secure`). Dashboard and API responses also carry `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin` and a `Content-Security-Policy` that loads scripts only from the server (`script-src 'self'`, no inline or eval) but lets the rrweb player's sandboxed `about:blank` iframe, which inherits the policy, render recorded pages: inline styles and `<style>` elements, and images, fonts, media and stylesheets from any http(s) origin and `data:`/`blob:` URLs. `/i` responses carry neither. Every other path that is not `/api` or `/i` serves the dashboard `index.html` (single-page app, `no-cache`) or its assets (`assets/*` cached for a year). `GET /healthz` answers `ok` for load balancers. Nodes without the `api` role serve only `/kimmi.js`, `/kimmi-feedback.js`, `/i` and `/healthz`. `/shared/{token}` is the dashboard's public page for a link.
