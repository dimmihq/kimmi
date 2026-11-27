# kimmi build contract

The single source of truth shared by the server, the browser SDK and the dashboard. If an implementation has to deviate, change this file in the same edit and say so in your report.

kimmi is self-hosted session replay: one Go binary that ingests rrweb recordings from a browser SDK, stores them on local disk or S3-compatible storage, indexes them in SQLite or PostgreSQL, and serves an embedded React dashboard.

## Repository layout

```
cmd/kimmi/            main: `kimmi serve`, `kimmi admin`, `kimmi loadgen`, `kimmi version`
internal/             all Go packages (config, store, blob, ingest, worker, api, auth, guard, bootstrap, project, webui)
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
| `KIMMI_DEBUG_ADDR` | none | Serves `net/http/pprof` under `/debug/pprof/` on this separate address (e.g. `127.0.0.1:6060`). Never exposed on the public listener; keep it off the network |

Sizes take a plain byte count or a `KB`/`MB`/`GB` (powers of 1000) or `KiB`/`MiB`/`GiB` suffix. Rate limits are in memory and per process.

## Memory

A node's memory is bounded by its settings, not by its traffic:

- Ingest holds at most `KIMMI_INGEST_BUFFER` of batches waiting to be written (a failed write keeps them, still counted), and reads at most another `KIMMI_INGEST_BUFFER` of request bodies at once (one body of up to 5 MB is always let through). Past either, batches get `503`. Live objects stream to storage from the buffer itself; nothing is copied into one big object first, and S3 uploads are single streamed PUTs.
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

Postgres: `sessions` is partitioned by day on `started_at`; retention drops whole partitions where every project agrees, and deletes by project otherwise. SQLite: same logical tables, no partitions. One `Store` interface, two implementations, one conformance test suite run against both.

### Storage tiers

1. **Live.** The ingest handler never decompresses the events. It copies each batch's compressed bytes into an in-memory buffer (bounded by `KIMMI_INGEST_BUFFER`, past which batches get `503`) and, every `KIMMI_FLUSH_INTERVAL` or as soon as 8 MiB (at most a quarter of the buffer) wait, streams one object `live/{yyyy-mm-dd}/{node}-{unixms}.bin` holding all buffered blocks back to back, then inserts `blocks` rows (file key, offset, length) and upserts the `sessions` rows from the batch metadata. A graceful shutdown flushes first.
2. **Sealed.** The worker finds sessions idle longer than `KIMMI_SESSION_IDLE`, reads their blocks in `seq` order, streams each one through gunzip event by event (one session and one sealing run at a time; a single event over 64 MiB is refused), re-encodes the session as zstd chunks of about 1 MB split on event boundaries, appends them to a per-project object `sealed/{retentionDays}d/{projectId}/{yyyy-mm-dd}/{uuid}.bin` (one new object per project per sealing run, closed at about 8 MiB and continued in another, since S3 objects cannot be appended to and the object is built in memory; chunks close at block boundaries, and only a single block over 1 MB is split between events), stores `sealed_key` and `sealed_chunks` (offset, length, first_ts, last_ts, events, first_seq, last_seq) on the session, and deletes its `blocks` rows. Live objects with no remaining blocks are deleted.
3. **Cleanup.** Nightly (and on demand): sessions past their project's retention are marked deleted and their sealed objects removed when no live session references them.

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
               "urlRules": [ { "type": "contains", "pattern": "/checkout" } ] }
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

### SDK surface (`@kimmi/browser`)

```ts
kimmi.init({ key: 'km_pub_...', host: 'http://localhost:8700', release?: string,
             scrub?: (text: string) => string /* runs on console, network, error and URL text before sending */ })
kimmi.identify(id: string, traits?: { email?: string; name?: string; [k: string]: unknown })
kimmi.optIn(); kimmi.optOut(); kimmi.stop(); kimmi.getSessionId(): string | null
```

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
Project = { id, name, slug, platform, origin, timezone, publicKey, origins: string[], retentionDays, createdAt,
            stats: { recordings24h, live, avgDurationMs, storageBytes, recordings, series: number[] /* 30 daily counts, oldest first */, lastRecordingAt: number|null } }
ProjectSettings = { privacy: {...as in /i/v1/config, including scrubEmails and scrubPhones}, capture: {...as in /i/v1/config, plus sampleRate}, retention: { days: 7|30|90|365, keepStarred: boolean } }
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

`/kimmi.js` serves the SDK IIFE bundle (5-minute cache). Every response carries `X-Content-Type-Options: nosniff`, and `Strict-Transport-Security: max-age=31536000` when `KIMMI_PUBLIC_URL` is https (cookies are then `Secure`). Dashboard and API responses also carry `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin` and a `Content-Security-Policy` that loads scripts only from the server (`script-src 'self'`, no inline or eval) but lets the rrweb player's sandboxed `about:blank` iframe, which inherits the policy, render recorded pages: inline styles and `<style>` elements, and images, fonts, media and stylesheets from any http(s) origin and `data:`/`blob:` URLs. `/i` responses carry neither. Every other path that is not `/api` or `/i` serves the dashboard `index.html` (single-page app, `no-cache`) or its assets (`assets/*` cached for a year). `GET /healthz` answers `ok` for load balancers. Nodes without the `api` role serve only `/kimmi.js`, `/i` and `/healthz`.
