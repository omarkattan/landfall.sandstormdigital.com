# Landfall

Maps Google ranking updates to client Search Console performance.

Round 1 delivered the data foundation. Round 2 adds segmentation and the
baseline model. Impact detection anchored to rollout dates comes in Round 3.

## Files

| File | Role |
|---|---|
| `server.js` | Express app, admin auth, API routes, cron entry points |
| `db.js` | Postgres pool, schema, monthly partition management |
| `google.js` | Service account JWT auth and Search Console API client |
| `ingest.js` | Job queue, slice runners, backfill and refresh |
| `updates.js` | Google Search Status Dashboard ingestion |
| `segments.js` | Segment rules, auto-derivation, SQL predicates |
| `baseline.js` | Same-weekday medians and expected range bands |
| `index.html` | Admin console |

## Segments and baselines

A segment is a named subset of one property's rows. Sitewide numbers hide what
an update did, because updates rarely move a whole site uniformly.

**Build segments** derives a starting set from the site's own data:

| Kind | Derived from |
|---|---|
| All traffic | the `total` slice |
| Page groups | the first path element of the highest-impression pages |
| Branded / Non-branded | brand terms, guessed from the domain, editable |
| Questions | queries opening with who, what, how and similar |
| Commercial intent | best, top, review, vs, pricing, near me and similar |
| Long tail | queries of four or more words |

Rules are stored in the database, not hard-coded, so they can be corrected per
client without a deploy. Rule types are `all`, `prefix`, `contains`, `regex`,
`not_regex` and `wordcount_gte`. Patterns are always bound as query parameters.

Note that Postgres uses POSIX regular expressions, where `\b` means backspace
rather than a word boundary. Use an explicit space or `( |$)` instead.

**The baseline** compares each day against the median of the same weekday over
the previous eight weeks. Weekly seasonality is the dominant cycle in search
traffic, and a same-weekday comparison removes it without modelling it.

Dispersion uses median absolute deviation scaled by 1.4826, so a single viral
day or outage does not widen the band the way a standard deviation would. The
expected range is the median plus or minus 1.96 estimated sigmas, with a five
percent floor so a perfectly flat history does not make every movement look
significant.

**The baseline adapts.** Eight weeks after a step change, the new level becomes
the expected level. So a segment that dropped in May reads as normal by July.
That is correct for anomaly detection and wrong for attribution, which is why
Round 3 anchors its comparison windows to rollout dates rather than to today.

Average position is impression-weighted. An unweighted average lets one
impression at position ninety count as heavily as a thousand at position two.

## 1. Google Cloud setup

1. Create a project at console.cloud.google.com.
2. Enable the **Google Search Console API** under APIs and Services.
3. IAM and Admin, Service Accounts, Create service account. No roles needed.
4. Open it, Keys, Add key, Create new key, JSON. Download it.

There is no OAuth client, no consent screen, and no verification.

## 2. Grant access to each client property

Copy `client_email` from the JSON. In Search Console, for every property:
Settings, Users and permissions, Add user, paste that email, **Restricted**.

## 3. Render setup

Create a **Postgres** instance first, in the same region as the web service.

- Build command: `npm install`
- Start command: `npm start`

| Variable | Value |
|---|---|
| `DATABASE_URL` | The **Internal Database URL** from your Render Postgres |
| `ADMIN_KEY` | A long random string. This is your login |
| `CRON_KEY` | A different long random string for the cron endpoints |
| `TOP_N` | Optional, default `500`. Top queries and pages stored per day |
| `BACKFILL_MONTHS` | Optional, default `16`. Search Console holds no more |

Google credentials, three ways, checked in this order:

**A.** `GOOGLE_SA_JSON`, the whole key file, minified to one line if the
dashboard mangles line breaks.
**B.** A secret file. Any `.json` in `/etc/secrets` or the project root that
parses as a service account key, or point `GOOGLE_SA_JSON_PATH` at one.
**C.** `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` separately. The
`private_key` value in the file is already one line, so it pastes cleanly.

## 4. Cron

cron-job.org, two jobs. Add `&budget=20000` and raise the job timeout to 30
seconds, since Render free-tier cold starts can eat a default 30 second budget.

```
POST https://your-app.onrender.com/api/ingest?key=YOUR_CRON_KEY&budget=20000
POST https://your-app.onrender.com/api/cron/refresh?key=YOUR_CRON_KEY
```

Every 2 minutes during a backfill, every 15 afterwards. The refresh runs daily.

## 5. First run

1. Sign in with `ADMIN_KEY`.
2. **Find properties**, then **Backfill** on each client.
3. **Sync from Google** under ranking updates.
4. Once rows are stored, **Build segments**.

## How the data is stored

`gsc_daily` holds five slices per property per day:

| Slice | Dimensions | Volume |
|---|---|---|
| `total` | date | 1 row per day |
| `device` | date, device | ~3 rows per day |
| `country` | date, country | ~50 rows per day |
| `query` | date, top N queries | up to `TOP_N` rows per day |
| `page` | date, top N pages | up to `TOP_N` rows per day |

Query and page slices make one API request per day so each day gets a true
top N, rather than a top N spread across a whole month.

Everything upserts on `(property_id, date, slice, dim_value)`, so re-running a
window is safe and picks up Google's late revisions. The table is partitioned
by month, created automatically.

## Troubleshooting

The app never crashes on a configuration problem. It starts, and the service
URL names the problem. The same text appears in the Render logs. The startup
log states the build, so a stale upload is obvious.

**Segments table is empty.** Choose **Build segments**. It needs rows stored
first, since page groups are derived from real traffic.

**A segment shows no data.** Check its pattern. Page rules match full URLs, so
`/blog/` needs the `contains` rule type rather than `prefix`.

**Everything reads flat after a known drop.** The baseline has adapted. Look at
a window that spans the rollout, or wait for Round 3.


## 1. Google Cloud setup

1. Create a project at console.cloud.google.com.
2. Enable the **Google Search Console API** under APIs and Services.
3. IAM and Admin, Service Accounts, Create service account. Name it `landfall`.
   No roles needed, skip both optional steps.
4. Open it, Keys, Add key, Create new key, JSON. Download it.

There is no OAuth client, no consent screen, and no verification. The service
account is just another user as far as Search Console is concerned. Ignore any
prompt to create an OAuth client.

## 2. Grant access to each client property

Copy `client_email` from the downloaded JSON. It looks like
`landfall@yourproject.iam.gserviceaccount.com`.

In Search Console, for every property: Settings, Users and permissions, Add
user, paste that email, permission **Restricted** is enough.

Both domain properties (`sc-domain:example.com`) and URL prefix properties
(`https://example.com/`) are supported.

## 3. Render setup

Create a **Postgres** instance first, in the same region as the web service,
then create the **Web Service** from this repo.

- Build command: `npm install`
- Start command: `npm start`

Environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The **Internal Database URL** from your Render Postgres |
| `ADMIN_KEY` | A long random string. This is your login |
| `CRON_KEY` | A different long random string for the cron endpoints |
| `TOP_N` | Optional, default `500`. Top queries and pages stored per day |
| `BACKFILL_MONTHS` | Optional, default `16`. Search Console holds no more |
| `TICK_BUDGET_MS` | Optional, default `45000` |

Names must match exactly. `ADMIN-KEY` or `admin_key` will not be read, though
the setup page will spot a near miss and tell you.

### Google credentials, three ways

Pick whichever works with your host. They are checked in this order.

**A. Secret file, most reliable.** Render dashboard, web service, Environment,
**Secret Files**. Upload the downloaded JSON as `service-account.json`. Nothing
else needed. Any single `.json` in `/etc/secrets` is picked up automatically,
or point `GOOGLE_SA_JSON_PATH` at a specific path.

**B. One environment variable.** Set `GOOGLE_SA_JSON` to the whole file. If the
dashboard mangles the line breaks, minify the JSON to a single line first and
paste that. Escaped `\n` sequences are repaired automatically.

**C. Two environment variables.** Set `GOOGLE_CLIENT_EMAIL` and
`GOOGLE_PRIVATE_KEY` separately. Surrounding quotes and escaped newlines in the
key are handled.

## 4. Cron

Use cron-job.org, same as your other tools. Two jobs:

**Ingest worker** - every 2 minutes while backfilling, every 15 minutes after.

```
POST https://your-app.onrender.com/api/ingest?key=YOUR_CRON_KEY
```

**Nightly refresh** - once a day, around 09:00 UTC.

```
POST https://your-app.onrender.com/api/cron/refresh?key=YOUR_CRON_KEY
```

The nightly job queues a rolling 14 day re-pull for every active property and
syncs the Google update calendar. The ingest worker drains the queue.

## 5. First run

1. Open the app, sign in with `ADMIN_KEY`.
2. Choose **Find properties**. Everything the service account can read appears,
   paused by default.
3. Choose **Backfill** on each client you want. This activates the property and
   queues about 80 jobs per property.
4. Choose **Sync from Google** under ranking updates.
5. Let the cron drain the queue. Thirty properties takes roughly a day and a
   half at a 2 minute cron interval.

## How the data is stored

`gsc_daily` holds five slices per property per day:

| Slice | Dimensions | Volume |
|---|---|---|
| `total` | date | 1 row per day |
| `device` | date, device | ~3 rows per day |
| `country` | date, country | ~50 rows per day |
| `query` | date, top N queries | up to `TOP_N` rows per day |
| `page` | date, top N pages | up to `TOP_N` rows per day |

Query and page slices make one API request per day so each day gets a true
top N, rather than a top N spread across a whole month.

Raw Search Console rows are never stored in full. At `TOP_N=500` expect roughly
1,050 rows per property per day, so about 15M rows for 30 properties across a
full 16 month backfill. The table is partitioned by month, created automatically.

Everything upserts on `(property_id, date, slice, dim_value)`, so re-running a
window is safe and picks up Google's late revisions.

## Troubleshooting

The app never crashes on a configuration problem. It starts, and the service URL
shows exactly what is wrong. The same text appears in the Render logs.

**"These environment variables are not set."** Add them under Environment. If a
variable exists under a slightly different name, the page says so.

**"No Google service account credentials found."** None of the three methods
above found anything. The secret file route is the most reliable.

**"is not valid JSON."** The value was truncated, usually by a dashboard that
does not accept line breaks. Minify the file to one line, or use a secret file.

**"Could not sign with the service account private key."** The key arrived
without its line breaks and could not be repaired. Use a secret file.

**"Could not reach Postgres."** Use the Internal Database URL, not the external
one, and confirm the database and web service are in the same region.

**Jobs land in error.** The message shows in the admin console next to the job.
**Retry failed** requeues them all.

## Notes

- Search Console finalises data about 3 days late. `DATA_LAG_DAYS` controls how
  far back "today" is treated as being.
- Jobs retry twice, then land in `error`.
- Node is pinned to 22.x. Render otherwise picks the newest release available.
