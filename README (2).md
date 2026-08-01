# Landfall

Maps Google ranking updates to client Search Console performance, and says what
it means.

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
| `impact.js` | Attribution, diagnosis, narrative and recommendations |
| `insights.js` | Always-on opportunities: CTR curve, striking distance, decay |
| `auth.js` | Accounts, sessions, Google sign-in, access requests |
| `mailer.js` | Outbound notifications through Resend |
| `landing.html` | Public page: explanation, FAQs, sign-in, access requests |
| `index.html` | The app, for signed-in accounts |

## Email notifications

Optional but worth having, since without it an access request is only visible
if somebody opens the People section and looks.

Four messages are sent, all after the response so a slow provider never delays
a form:

| Trigger | Goes to |
|---|---|
| Someone requests access | You, with reply-to set to them |
| Someone requests access | Them, as confirmation |
| A new account lands pending | You, with an approve link |
| You approve an account | Them, telling them they are in |

Set up at resend.com: add `sandstormdigital.com` as a domain, add the DNS
records it gives you, then create an API key.

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | The API key from Resend |
| `MAIL_FROM` | `Landfall <landfall@sandstormdigital.com>` |
| `MAIL_TO` | Where notifications land, e.g. `omar@sandstormdigital.com` |
| `APP_URL` | `https://landfall.sandstormdigital.com`, used in links |

`MAIL_FROM` must be on a domain verified in Resend. An unverified sender is
the usual reason messages vanish.

**Nothing breaks if this is unconfigured.** Requests are still recorded, and
the People section says which variables are missing. Once configured, it shows
where notifications go, when one last went out, and the last error if any,
with a button to send a test.

## How an update finding is produced

## Accounts

One URL serves both pages. Signed-out visitors get `landing.html`, signed-in
accounts get the app, with no redirect that would flash the wrong page first.

There are two ways in. The **admin key** is the bootstrap credential and always
works, so you are never locked out. **Accounts** are for everyone else.

The first account created becomes an active owner, so a fresh deployment is
usable without touching the database. Every account after that starts
**pending** and cannot see anything until an owner approves it under People.
That matters because the page is public: without it, anyone who signed up would
be looking at your clients' data.

Sessions are stateless signed tokens rather than database rows, compared in
constant time so a wrong signature cannot be narrowed down by timing. Passwords
are hashed with scrypt. A failed sign-in returns the same message whether the
account exists or the password was wrong, so the form cannot be used to
discover which addresses have accounts.

### Google sign-in

Optional. Without `GOOGLE_OAUTH_CLIENT_ID` the button hides and email sign-in
carries on working.

To turn it on, in the same Google Cloud project: APIs and Services, Credentials,
Create credentials, **OAuth client ID**, Web application. Add your site to
**Authorised JavaScript origins**, for example
`https://landfall.sandstormdigital.com`. Copy the client ID into
`GOOGLE_OAUTH_CLIENT_ID`.

This is a different thing from the service account, which stays as it is.
Sign-in only reads name and email, which are not sensitive scopes, so it needs
no app verification. You will be asked to fill in the consent screen once.

Google accounts follow the same rule as email ones: the first is an owner, the
rest are pending until approved.

## How an update finding is produced

## What to work on

Update attribution only says something on the handful of days a year when an
update actually moved the site. The rest of the time the same data still
contains work worth doing, and `insights.js` finds it. This runs on every load
and does not depend on an update having happened.

**Your own click-through curve.** Rather than comparing against published CTR
tables, the site's real curve is fitted from its own data: a power law through
the seventieth percentile of each position bucket. The seventieth percentile
rather than the median, so "expected" means what a well-written listing of
yours achieves, not the average of good and bad ones. A fitted curve rather
than the raw buckets, because on a small site one underperforming page can
define a whole position and then never be flagged as underperforming.

Tested against a synthetic population with a known curve, the fit lands within
0.2 percentage points at every position from 1 to 20.

Four findings come out of it:

| Finding | Test | Why it matters |
|---|---|---|
| One push from the top | position 4 to 20, 50+ impressions | The page already ranks. Upside is measured against what the site earns at position three |
| Ranks well, not clicked | top ten, under 60% of curve | Either the title is wrong or something above the organic result is taking the click |
| Decaying | 28 days against the previous 28, down 25%+ | Gradual decay never trips an update-anchored comparison |
| Growing | same window, up 30%+ | Demand moving toward a query is the clearest case for new content |

Every finding names the specific queries or URLs it applies to, with the clicks
at stake, because advice without a target is something nobody gets round to.

## How an update finding is produced

**1. Freeze the expectation.** The rolling baseline adapts within about eight
weeks, so by the time you look, a step change has become the new normal. For
attribution the baseline is frozen at the day before the rollout started and
projected forward, using same-weekday medians from the eight weeks before.

**2. Compare whole weeks.** The window opens the day after the rollout
completes and runs in multiples of seven days, so both sides contain the same
number of each weekday. Google's own guidance is to wait for completion before
drawing conclusions.

**3. Read three metrics together, not one.** Clicks alone cannot tell you what
happened. Clicks against impressions and position can:

| Clicks | Impressions | Position | Reading |
|---|---|---|---|
| down | down | worse | Rankings fell |
| down | down | holding | Shown for fewer searches |
| down | holding | holding | Clicks lost above the results |
| up | up | better | Rankings improved |

"Clicks lost above the results" is the AI Overview signature: the listing is
still there in the same place and people are not choosing it.

**4. Test selective against uniform.** If some segments fell while others held,
that is Google reassessing part of the site. If everything fell together, an
update is the wrong explanation, because updates rarely move a whole site
uniformly. Check deploys, robots.txt, redirects and canonicals first.

**5. Recommend by cause, not by segment.** Recommendations are grouped by the
underlying diagnosis and name every segment they cover, so the same advice is
never repeated once per segment.

A segment must clear roughly 8% movement, a z-score of 1.5, and 200 expected
impressions before it counts. Below that it is called steady, because a finding
you cannot defend is worse than no finding.

Narratives are templates, not generated prose. The same data always produces
the same statement, and every sentence can be traced to a number.

## Segments

**Build segments** derives a starting set from the site's own data:

| Kind | Derived from |
|---|---|
| All traffic | the `total` slice |
| Page groups | the first path element of the highest-impression pages |
| Branded / Non-branded | brand terms, guessed from the domain, editable |
| Questions | queries opening with who, what, how and similar |
| Commercial intent | best, top, review, vs, pricing, near me and similar |
| Long tail | queries of four or more words |

Rules are stored in the database, so they can be corrected per client without a
deploy. Rule types are `all`, `prefix`, `contains`, `regex`, `not_regex` and
`wordcount_gte`. Patterns are bound as query parameters, never interpolated.

Postgres uses POSIX regular expressions, where `\b` means backspace rather than
a word boundary. Use an explicit space or `( |$)` instead.

Average position is impression-weighted throughout. An unweighted average lets
one impression at position ninety count as heavily as a thousand at position two.

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
| `GOOGLE_OAUTH_CLIENT_ID` | Optional. Turns on Google sign-in |
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

1. Open the site. Sign in with the admin key, or create the first account,
   which becomes the owner automatically.
2. **Find properties**, then **Backfill** on each client.
3. **Sync from Google** under ranking updates.
4. Once rows are stored, **Build segments**.
5. Pick an update at the top of the page.

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
URL names the problem. The startup log states the build, so a stale upload is
obvious.

**"Only N days of data since this rollout finished."** At least 14 days after
completion are needed. Wait, or pick an older update.

**"Only N days of data before this rollout."** At least 28 days of history
before the rollout are needed to model what should have happened.

**Every update reads as no impact.** That is a real answer. It means these
updates do not explain what you are seeing, and the cause is elsewhere.

**A segment shows no data.** Check its pattern. Page rules match full URLs, so
`/blog/` needs `contains` rather than `prefix`.


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
| `GOOGLE_OAUTH_CLIENT_ID` | Optional. Turns on Google sign-in |
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

1. Open the site. Sign in with the admin key, or create the first account,
   which becomes the owner automatically.
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
| `GOOGLE_OAUTH_CLIENT_ID` | Optional. Turns on Google sign-in |
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
