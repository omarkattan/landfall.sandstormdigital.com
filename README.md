# Landfall

Maps Google ranking updates to client Search Console performance.

Round 1 delivers the data foundation: service account auth, property discovery,
a 16 month backfill, a nightly refresh, and the Google ranking update calendar.
Impact detection comes in Round 3.

## Files

| File | Role |
|---|---|
| `server.js` | Express app, admin auth, API routes, cron entry points |
| `db.js` | Postgres pool, schema, monthly partition management |
| `google.js` | Service account JWT auth and Search Console API client |
| `ingest.js` | Job queue, slice runners, backfill and refresh |
| `updates.js` | Google Search Status Dashboard ingestion |
| `public/index.html` | Admin console |

## 1. Google Cloud setup

1. Create a project at console.cloud.google.com.
2. Enable the **Google Search Console API** under APIs and Services.
3. Go to IAM and Admin, Service Accounts, Create service account. Name it
   `landfall`. No roles needed.
4. Open the service account, Keys, Add key, Create new key, JSON. Download it.
5. Copy the `client_email` value. It looks like
   `landfall@yourproject.iam.gserviceaccount.com`.

There is no OAuth consent screen and no verification. The service account is
just another user as far as Search Console is concerned.

## 2. Grant access to each client property

In Search Console, for every property:

Settings, Users and permissions, Add user, paste the service account email,
permission **Full** or **Restricted** (either works, Restricted is enough).

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
| `GOOGLE_SA_JSON` | The entire contents of the downloaded JSON key file |
| `TOP_N` | Optional, default `500`. Top queries and pages stored per day |
| `BACKFILL_MONTHS` | Optional, default `16`. Search Console holds no more |
| `TICK_BUDGET_MS` | Optional, default `45000` |

`GOOGLE_SA_JSON` must be the whole file including the outer braces. Escaped
newlines in `private_key` are repaired automatically.

**If something is misconfigured the app still starts.** Open the service URL
and the page names the exact problem. The same text appears in the Render logs.
Fix it under Environment, then redeploy.

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

**The page says environment variables are not set.** Add them under Environment
on the web service and redeploy. The page lists exactly which ones.

**The page says it could not reach Postgres.** Use the Internal Database URL,
not the external one, and confirm the database and web service are in the same
region.

**Jobs land in error.** The message is visible in the admin console next to the
job. **Retry failed** requeues them all.

**Update sync fails.** The Search Status Dashboard feed may have changed shape.
**Add by hand** still works and nothing else is affected.

## Notes

- Search Console finalises data about 3 days late. `DATA_LAG_DAYS` controls how
  far back "today" is treated as being. Requests never go past that.
- Jobs retry twice, then land in `error`.
- Node is pinned to 22.x. Render otherwise picks the newest release available.
