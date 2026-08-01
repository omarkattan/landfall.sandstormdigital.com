'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const PORT = process.env.PORT || 3000;
const TICK_BUDGET_MS = parseInt(process.env.TICK_BUDGET_MS || '45000', 10);

// Bumped on every delivered change, so a stale file on the server is obvious
// from the logs and from /api/setup rather than guessed at.
const BUILD = 'r4-1';

function envValue(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

const ADMIN_KEY = envValue('ADMIN_KEY');
const CRON_KEY = envValue('CRON_KEY');

/**
 * The console is served from public/index.html when that exists, and from the
 * repo root otherwise, so a flat repo works without moving files around.
 */
const STATIC_DIRS = [path.join(__dirname, 'public'), __dirname, process.cwd()]
  .map((d) => path.resolve(d))
  .filter((d, i, all) => all.indexOf(d) === i)
  .filter((d) => {
    try {
      return fs.existsSync(d) && fs.statSync(d).isDirectory();
    } catch (e) {
      return false;
    }
  });

function findIndexHtml() {
  for (const dir of STATIC_DIRS) {
    const candidate = path.join(dir, 'index.html');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (e) {
      // unreadable, keep looking
    }
  }
  return null;
}

function describeStaticDirs() {
  return STATIC_DIRS.map((d) => {
    let files;
    try {
      files = fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.html'));
    } catch (e) {
      return `  ${d} - unreadable`;
    }
    return `  ${d} - ${files.length ? files.join(', ') : 'no .html files'}`;
  }).join('\n');
}

/**
 * Holds the reason the app is not usable, if any. When this is set the server
 * still listens and every route explains the problem, rather than exiting.
 * A crash loop on Render produces no readable output, because stderr is a pipe
 * and process.exit() discards writes that have not flushed yet.
 */
let startupProblem = null;

const REQUIRED = [
  ['DATABASE_URL', 'the Internal Database URL from your Render Postgres instance'],
  ['ADMIN_KEY', 'a long random string, used to sign in'],
  ['CRON_KEY', 'a different long random string, used by the cron jobs']
];

/**
 * Catches the most common cause of a "not set" variable: it is set, but under a
 * slightly different name. Looks for anything that matches once spaces, dashes,
 * underscores and case are ignored.
 */
function nearMisses(name) {
  const flatten = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = flatten(name);
  return Object.keys(process.env).filter((k) => k !== name && flatten(k) === target);
}

function describeMissing(name, hint) {
  const near = nearMisses(name);
  let line = `  ${name}\n    ${hint}`;
  if (near.length) {
    line += `\n    Found a variable named "${near[0]}". Rename it to exactly ${name}.`;
  } else if (name in process.env) {
    line += `\n    This variable exists but its value is empty.`;
  }
  return line;
}

// Platform and toolchain variables, hidden so the list shows only what you set.
const NOISE = /^(PATH|HOME|PWD|SHLVL|_|TERM|LANG|USER|HOSTNAME|TMPDIR|OLDPWD|SHELL|EDITOR|PAGER|COLUMNS|LINES|GOPATH|GOROOT|GOCACHE|GOMODCACHE)$|^(LC_|npm_|NODE_|YARN_|NVM_|RENDER_|BUN_|PYTHON|GEM_|RUBY|JAVA_)/;

/**
 * Names only, never values. Seeing the exact list removes the guesswork when a
 * variable appears to be set in the dashboard but is not reaching the process.
 */
function visibleEnvNames() {
  return Object.keys(process.env).filter((k) => !NOISE.test(k)).sort();
}

function envInventory() {
  const names = visibleEnvNames();
  if (!names.length) {
    return 'No custom environment variables are reaching this app at all.\n' +
      'That usually means the values were entered but not saved, or they were\n' +
      'added to a different service.';
  }
  return 'Environment variables this app can currently see (names only):\n  ' +
    names.join(', ');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[api]', err.message);
      res.status(500).json({ error: err.message });
    });
  };
}

app.get('/healthz', (req, res) => {
  res.json({ ok: !startupProblem, build: BUILD, problem: startupProblem });
});

app.get('/api/setup', (req, res) => {
  res.json({ ready: !startupProblem, build: BUILD, problem: startupProblem });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/setup') return next();
  if (startupProblem) {
    return res.status(503).json({ error: startupProblem });
  }
  return next();
});

const db = require('./db');
const google = require('./google');
const ingest = require('./ingest');
const updates = require('./updates');
const segments = require('./segments');
const baseline = require('./baseline');
const impact = require('./impact');
const insights = require('./insights');
const auth = require('./auth');
const mailer = require('./mailer');

/**
 * Two ways in. The admin key is the bootstrap credential and always works.
 * Accounts are for everyone else, and are inert until approved, so a public
 * sign-up page cannot hand anybody your clients' data.
 */
async function currentUser(req) {
  if (req.cookies && req.cookies.lf_key === ADMIN_KEY) {
    return { id: 0, email: 'admin', role: 'admin', status: 'active', viaKey: true };
  }
  const session = auth.readSession(req.cookies && req.cookies.lf_sess);
  if (!session) return null;

  const user = await auth.findUserById(session.userId);
  if (!user || user.status !== 'active') return null;
  return user;
}

function requireAdmin(req, res, next) {
  currentUser(req).then((user) => {
    if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
    req.user = user;
    next();
  }).catch((err) => res.status(500).json({ error: err.message }));
}

function requireOwner(req, res, next) {
  if (req.user && (req.user.viaKey || req.user.role === 'admin')) return next();
  return res.status(403).json({ error: 'Only an account owner can do that.' });
}

function requireCron(req, res) {
  const key = req.query.key || req.headers['x-cron-key'];
  if (key !== CRON_KEY) {
    res.status(401).json({ error: 'Bad cron key.' });
    return false;
  }
  return true;
}

const COOKIE = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 60 * 60 * 1000
};

app.get('/api/auth/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || null });
});

app.post('/api/login', (req, res) => {
  const key = (req.body && req.body.key) || '';
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'That key does not match.' });
  res.cookie('lf_key', key, COOKIE);
  res.json({ ok: true });
});

app.post('/api/auth/register', wrap(async (req, res) => {
  const { email, password, name } = req.body || {};
  const clean = auth.normaliseEmail(email);

  if (!auth.validEmail(clean)) return res.status(400).json({ error: 'That does not look like an email address.' });
  const problem = auth.passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });

  const existing = await auth.findUserByEmail(clean);
  if (existing) return res.status(409).json({ error: 'There is already an account with that email. Try signing in.' });

  const user = await auth.createUser({ email: clean, name, password });
  if (user.status === 'active') {
    res.cookie('lf_sess', auth.issueSession(user.id), COOKIE);
    await auth.touchLogin(user.id);
  }
  res.json({ status: user.status });

  if (user.status === 'pending') {
    mailer.notifyNewAccount(user).catch((err) => console.error('[mail]', err.message));
  }
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await auth.findUserByEmail(email);

  // The same message either way, so this cannot be used to discover which
  // email addresses have accounts.
  const rejection = { error: 'That email and password do not match.' };
  if (!user || !user.password_hash) return res.status(401).json(rejection);
  if (!auth.verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json(rejection);
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'That account is waiting to be approved.' });
  }

  res.cookie('lf_sess', auth.issueSession(user.id), COOKIE);
  await auth.touchLogin(user.id);
  res.json({ status: 'active' });
}));

app.post('/api/auth/google', wrap(async (req, res) => {
  const profile = await auth.verifyGoogleToken((req.body || {}).credential);
  let user = await auth.findUserByEmail(profile.email);

  if (!user) {
    user = await auth.createUser({ email: profile.email, name: profile.name, googleSub: profile.sub });
  } else if (!user.google_sub) {
    await db.query('update users set google_sub = $2 where id = $1', [user.id, profile.sub]);
  }

  if (user.status !== 'active') {
    res.json({ status: user.status });
    mailer.notifyNewAccount(user).catch((err) => console.error('[mail]', err.message));
    return;
  }

  res.cookie('lf_sess', auth.issueSession(user.id), COOKIE);
  await auth.touchLogin(user.id);
  res.json({ status: 'active' });
}));

app.post('/api/logout', (req, res) => {
  res.clearCookie('lf_key');
  res.clearCookie('lf_sess');
  res.json({ ok: true });
});

app.get('/api/session', wrap(async (req, res) => {
  const user = await currentUser(req);
  res.json({
    signedIn: Boolean(user),
    email: user ? user.email : null,
    name: user ? user.name : null,
    owner: Boolean(user && (user.viaKey || user.role === 'admin'))
  });
}));

app.post('/api/waitlist', wrap(async (req, res) => {
  const body = req.body || {};
  if (!auth.validEmail(auth.normaliseEmail(body.email))) {
    return res.status(400).json({ error: 'That does not look like an email address.' });
  }
  const r = await auth.addToWaitlist(body);
  res.json({ ok: true, created: r.created });

  // After the response, so a slow mail provider never delays the form.
  if (r.created) {
    mailer.notifyAccessRequest({
      email: auth.normaliseEmail(body.email),
      name: body.name, company: body.company,
      website: body.website, note: body.note
    }).catch((err) => console.error('[mail]', err.message));
  }
}));

// ------------------------------------------------------------- people

app.get('/api/people', requireAdmin, requireOwner, wrap(async (req, res) => {
  const [users, list] = await Promise.all([
    db.query(`select id, email, name, role, status, created_at, last_login_at
                from users order by status, created_at desc`),
    db.query(`select id, email, name, company, website, note, created_at
                from waitlist order by created_at desc limit 100`)
  ]);
  res.json({
    users: users.rows,
    waitlist: list.rows,
    mail: {
      ...mailer.status(),
      lastSent: await mailer.lastSent(),
      lastError: (await mailer.lastError()) || null
    }
  });
}));

app.post('/api/mail/test', requireAdmin, requireOwner, wrap(async (req, res) => {
  const state = mailer.status();
  if (!state.configured) {
    return res.status(400).json({
      error: `Email is not configured. Add ${state.missing.join(', ')} under Environment.`
    });
  }
  const to = ((req.body && req.body.to) || '').trim() || null;
  await mailer.sendTest(to);
  res.json({ ok: true, to: to || state.to });
}));

app.post('/api/people/:id/status', requireAdmin, requireOwner, wrap(async (req, res) => {
  const status = (req.body && req.body.status) || '';
  if (!['active', 'pending', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'Status must be active, pending, or blocked.' });
  }
  const r = await db.query(
    'update users set status = $2 where id = $1 returning id, email, status',
    [req.params.id, status]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'No such person.' });
  res.json(r.rows[0]);

  if (status === 'active') {
    mailer.notifyApproved(r.rows[0]).catch((err) => console.error('[mail]', err.message));
  }
}));

app.get('/api/status', requireAdmin, wrap(async (req, res) => {
  const [props, jobs, rows, upd, lastSync, lastErr] = await Promise.all([
    db.query(`select count(*) filter (where active) as active, count(*) as total from properties`),
    db.query(`select status, count(*)::int as n from ingest_jobs group by status`),
    db.query(`select count(*)::bigint as n, min(date) as first_date, max(date) as last_date from gsc_daily`),
    db.query(`select count(*)::int as n from algo_updates`),
    db.getMeta('updates_last_sync'),
    db.getMeta('updates_last_error')
  ]);

  const jobCounts = {};
  jobs.rows.forEach((r) => { jobCounts[r.status] = r.n; });

  res.json({
    serviceAccount: google.serviceAccountEmail(),
    properties: props.rows[0],
    jobs: jobCounts,
    metrics: rows.rows[0],
    updates: upd.rows[0].n,
    updatesLastSync: lastSync,
    updatesLastError: lastErr || null
  });
}));

app.get('/api/properties', requireAdmin, wrap(async (req, res) => {
  const r = await db.query(
    `select p.*,
            (select count(*)::int from ingest_jobs j
              where j.property_id = p.id and j.status = 'queued') as queued,
            (select count(*)::int from ingest_jobs j
              where j.property_id = p.id and j.status = 'error') as errored,
            (select max(date) from gsc_daily g where g.property_id = p.id) as last_date
       from properties p
      order by p.active desc, p.site_url`
  );
  res.json(r.rows);
}));

app.post('/api/properties/sync', requireAdmin, wrap(async (req, res) => {
  const sites = await google.listSites();
  let added = 0;

  for (const s of sites) {
    const r = await db.query(
      `insert into properties (site_url, property_type, permission, active)
       values ($1, $2, $3, false)
       on conflict (site_url) do update set permission = excluded.permission
       returning (xmax = 0) as inserted`,
      [s.siteUrl, s.propertyType, s.permission]
    );
    if (r.rows[0] && r.rows[0].inserted) added += 1;
  }

  res.json({ found: sites.length, added });
}));

app.post('/api/properties/:id/toggle', requireAdmin, wrap(async (req, res) => {
  const r = await db.query(
    `update properties set active = not active where id = $1 returning id, active`,
    [req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'No such property.' });
  res.json(r.rows[0]);
}));

app.post('/api/properties/:id/label', requireAdmin, wrap(async (req, res) => {
  const label = (req.body && req.body.label) || null;
  await db.query('update properties set label = $2 where id = $1', [req.params.id, label]);
  res.json({ ok: true });
}));

app.post('/api/properties/:id/backfill', requireAdmin, wrap(async (req, res) => {
  await db.query('update properties set active = true where id = $1', [req.params.id]);
  const queued = await ingest.queueBackfill(req.params.id);
  res.json({ queued });
}));

app.post('/api/refresh', requireAdmin, wrap(async (req, res) => {
  const queued = await ingest.queueRefresh();
  res.json({ queued });
}));

app.post('/api/jobs/retry', requireAdmin, wrap(async (req, res) => {
  const r = await db.query(
    `update ingest_jobs set status = 'queued', attempts = 0, error = null
      where status = 'error' returning id`
  );
  res.json({ requeued: r.rowCount });
}));

app.get('/api/jobs', requireAdmin, wrap(async (req, res) => {
  const [counts, active, next, recent] = await Promise.all([
    db.query(`select status, count(*)::int as n from ingest_jobs group by status`),
    db.query(
      `select j.id, j.slice, j.start_date, j.end_date, j.status, j.attempts,
              j.rows_written, j.error, p.site_url
         from ingest_jobs j join properties p on p.id = j.property_id
        where j.status in ('running','error')
        order by j.status, j.id desc
        limit 50`
    ),
    db.query(
      `select j.slice, j.start_date, j.end_date, p.site_url
         from ingest_jobs j join properties p on p.id = j.property_id
        where j.status = 'queued'
        order by j.priority asc, j.id asc
        limit 5`
    ),
    db.query(
      `select j.slice, j.start_date, j.end_date, j.rows_written, j.finished_at, p.site_url
         from ingest_jobs j join properties p on p.id = j.property_id
        where j.status = 'done'
        order by j.finished_at desc nulls last
        limit 5`
    )
  ]);

  const byStatus = { queued: 0, running: 0, done: 0, error: 0 };
  counts.rows.forEach((r) => { byStatus[r.status] = r.n; });
  const total = byStatus.queued + byStatus.running + byStatus.done + byStatus.error;

  res.json({
    counts: byStatus,
    total,
    active: active.rows,
    next: next.rows,
    recent: recent.rows
  });
}));

app.get('/api/updates', requireAdmin, wrap(async (req, res) => {
  res.json(await updates.listUpdates(60));
}));

app.post('/api/updates/sync', requireAdmin, wrap(async (req, res) => {
  res.json(await updates.syncGoogleUpdates());
}));

app.post('/api/updates/manual', requireAdmin, wrap(async (req, res) => {
  const id = await updates.addManualUpdate(req.body || {});
  res.json({ id });
}));

app.post('/api/tick', requireAdmin, wrap(async (req, res) => {
  const budget = Math.min(parseInt(req.query.budget || '25000', 10), 120000);
  res.json(await ingest.runTick(budget));
}));

// ---------------------------------------------------------------- segments

/**
 * Findings that do not depend on an update having happened. This is what the
 * console shows most of the time, since updates are rare and work is not.
 */
app.get('/api/opportunities', requireAdmin, wrap(async (req, res) => {
  const propertyId = parseInt(req.query.property_id, 10);
  if (!propertyId) return res.status(400).json({ error: 'property_id is required.' });
  res.json(await insights.buildOpportunities(propertyId));
}));

/**
 * The reading of the data, not the data itself. One update, one property,
 * assessed against a baseline frozen before the rollout began.
 */
app.get('/api/findings', requireAdmin, wrap(async (req, res) => {
  const propertyId = parseInt(req.query.property_id, 10);
  const updateId = req.query.update_id;
  if (!propertyId || !updateId) {
    return res.status(400).json({ error: 'property_id and update_id are required.' });
  }

  const u = await db.query('select * from algo_updates where id = $1', [updateId]);
  if (!u.rows[0]) return res.status(404).json({ error: 'No such update.' });

  const result = await impact.assessUpdate(propertyId, u.rows[0]);
  if (!result) return res.json({ status: 'no_data', message: 'No stored data for this property yet.' });
  res.json(result);
}));

/**
 * Every update that can be assessed, newest first, so the console can offer a
 * list without running the full assessment for each one.
 */
app.get('/api/findings/updates', requireAdmin, wrap(async (req, res) => {
  const propertyId = parseInt(req.query.property_id, 10);
  if (!propertyId) return res.status(400).json({ error: 'property_id is required.' });

  const bounds = await db.query(
    'select min(date)::text as first, max(date)::text as last from gsc_daily where property_id = $1',
    [propertyId]
  );
  const first = bounds.rows[0] && bounds.rows[0].first;
  const last = bounds.rows[0] && bounds.rows[0].last;
  if (!first) return res.json({ rows: [], coverage: null });

  const r = await db.query(
    `select id, name, update_type, began_at, ended_at, url
       from algo_updates
      where began_at is not null
        and began_at::date >= $1::date
        and began_at::date <= $2::date
      order by began_at desc`,
    [first, last]
  );
  res.json({ rows: r.rows, coverage: { first, last } });
}));

app.get('/api/segments', requireAdmin, wrap(async (req, res) => {
  const propertyId = parseInt(req.query.property_id, 10);
  if (!propertyId) return res.status(400).json({ error: 'property_id is required.' });
  res.json(await segments.listSegments(propertyId));
}));

app.post('/api/segments', requireAdmin, wrap(async (req, res) => {
  const body = req.body || {};
  const propertyId = parseInt(body.property_id, 10);
  if (!propertyId) return res.status(400).json({ error: 'property_id is required.' });
  if (!String(body.name || '').trim()) return res.status(400).json({ error: 'A segment needs a name.' });

  res.json(await segments.createSegment({
    property_id: propertyId,
    kind: body.kind,
    name: String(body.name).trim(),
    rule_type: body.rule_type,
    pattern: body.pattern,
    sort_order: 500
  }));
}));

app.delete('/api/segments/:id', requireAdmin, wrap(async (req, res) => {
  const propertyId = parseInt(req.query.property_id, 10);
  const removed = await segments.deleteSegment(parseInt(req.params.id, 10), propertyId);
  if (!removed) return res.status(404).json({ error: 'No such segment.' });
  res.json({ ok: true });
}));

app.post('/api/segments/auto', requireAdmin, wrap(async (req, res) => {
  const propertyId = parseInt((req.body && req.body.property_id) || req.query.property_id, 10);
  if (!propertyId) return res.status(400).json({ error: 'property_id is required.' });

  const p = await db.query('select site_url, brand_terms from properties where id = $1', [propertyId]);
  if (!p.rows[0]) return res.status(404).json({ error: 'No such property.' });

  const stored = p.rows[0].brand_terms
    ? p.rows[0].brand_terms.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  const result = await segments.autoCreate(propertyId, p.rows[0].site_url, stored);

  if (!stored) {
    await db.query('update properties set brand_terms = $2 where id = $1',
      [propertyId, result.brandTerms.join(', ')]);
  }
  res.json(result);
}));

app.post('/api/properties/:id/brand', requireAdmin, wrap(async (req, res) => {
  const terms = String((req.body && req.body.terms) || '').trim();
  await db.query('update properties set brand_terms = $2 where id = $1', [req.params.id, terms || null]);
  res.json({ ok: true });
}));

/**
 * Daily series for one segment with its expected range, plus any ranking
 * updates whose rollout overlaps the window.
 */
app.get('/api/series', requireAdmin, wrap(async (req, res) => {
  const segmentId = parseInt(req.query.segment_id, 10);
  const metric = ['clicks', 'impressions', 'position'].includes(req.query.metric)
    ? req.query.metric : 'clicks';
  const days = Math.min(Math.max(parseInt(req.query.days || '180', 10), 28), 500);

  const s = await db.query('select * from segments where id = $1', [segmentId]);
  if (!s.rows[0]) return res.status(404).json({ error: 'No such segment.' });
  const rule = s.rows[0];

  const bounds = await db.query(
    'select min(date)::text as first, max(date)::text as last from gsc_daily where property_id = $1',
    [rule.property_id]
  );
  if (!bounds.rows[0] || !bounds.rows[0].last) {
    return res.json({ segment: rule, metric, points: [], updates: [], summary: null });
  }

  const last = bounds.rows[0].last;
  const windowStart = baseline.addDays(last, -(days - 1));
  // Pull extra history so the first visible day still has a full lookback.
  const fetchStart = baseline.addDays(windowStart, -70);
  const from = fetchStart < bounds.rows[0].first ? bounds.rows[0].first : fetchStart;

  const raw = await segments.dailySeries(rule, from, last);
  const dense = segments.densify(raw, from, last);

  const series = dense.map((d) => ({
    date: d.date,
    value: metric === 'position' ? d.position : d[metric]
  })).filter((d) => d.value != null || metric !== 'position');

  const modelled = baseline.buildBaseline(
    series.map((d) => ({ date: d.date, value: d.value == null ? 0 : d.value })),
    { lowerIsBetter: metric === 'position' }
  );

  const visible = modelled.filter((p) => p.date >= windowStart);

  const updates = await db.query(
    `select id, name, update_type, began_at, ended_at, url
       from algo_updates
      where began_at is not null
        and began_at::date <= $2::date
        and coalesce(ended_at::date, current_date) >= $1::date
      order by began_at`,
    [windowStart, last]
  );

  res.json({
    segment: rule,
    metric,
    from: windowStart,
    to: last,
    points: visible,
    updates: updates.rows,
    summary: baseline.summarise(modelled, baseline.addDays(last, -27), last)
  });
}));

/**
 * One row per segment for the chosen window, so the segments that moved
 * stand out against the ones that did not.
 */
app.get('/api/segments/overview', requireAdmin, wrap(async (req, res) => {
  const propertyId = parseInt(req.query.property_id, 10);
  const metric = ['clicks', 'impressions'].includes(req.query.metric) ? req.query.metric : 'clicks';
  const days = Math.min(Math.max(parseInt(req.query.days || '28', 10), 7), 90);
  if (!propertyId) return res.status(400).json({ error: 'property_id is required.' });

  const bounds = await db.query(
    'select max(date)::text as last from gsc_daily where property_id = $1',
    [propertyId]
  );
  const last = bounds.rows[0] && bounds.rows[0].last;
  if (!last) return res.json({ rows: [], window: null });

  const windowStart = baseline.addDays(last, -(days - 1));
  const fetchStart = baseline.addDays(windowStart, -70);

  const defs = await segments.listSegments(propertyId);
  const rows = [];

  for (const rule of defs) {
    const raw = await segments.dailySeries(rule, fetchStart, last);
    const dense = segments.densify(raw, fetchStart, last);
    const modelled = baseline.buildBaseline(
      dense.map((d) => ({ date: d.date, value: d[metric] })),
      { lowerIsBetter: false }
    );
    rows.push({
      id: rule.id,
      kind: rule.kind,
      name: rule.name,
      ...baseline.summarise(modelled, windowStart, last)
    });
  }

  res.json({ rows, window: { from: windowStart, to: last, days, metric } });
}));

app.all('/api/ingest', wrap(async (req, res) => {
  if (!requireCron(req, res)) return;
  const budget = Math.min(parseInt(req.query.budget || TICK_BUDGET_MS, 10), 120000);
  res.json(await ingest.runTick(budget));
}));

app.all('/api/cron/refresh', wrap(async (req, res) => {
  if (!requireCron(req, res)) return;
  const queued = await ingest.queueRefresh();
  let synced;
  try {
    synced = await updates.syncGoogleUpdates();
  } catch (err) {
    synced = { error: err.message };
  }
  res.json({ queued, updates: synced });
}));

// Serve assets from public/ when present, otherwise from the repo root.
// The guard blocks source files, which would otherwise be reachable by URL
// when the root itself is the static directory.
const BLOCKED = /\.(js|json|md|lock|env|sql|ya?ml|txt)$/i;
app.use((req, res, next) => {
  if (req.method === 'GET' && BLOCKED.test(req.path) && !req.path.startsWith('/api')) {
    return res.status(404).type('text').send('Not found');
  }
  next();
});
for (const dir of STATIC_DIRS) {
  app.use(express.static(dir, { index: false, dotfiles: 'deny' }));
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
body{margin:0;background:#0e1218;color:#dde3ec;font-family:system-ui,-apple-system,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
main{max-width:640px}
h1{font-size:15px;letter-spacing:.16em;text-transform:uppercase;margin:0 0 18px;font-weight:600}
h1 span{color:#d9a441}
pre{background:#161c26;border:1px solid #252d3a;border-left:3px solid #e0655c;
border-radius:3px;padding:14px 16px;white-space:pre-wrap;word-break:break-word;
font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.55;margin:0 0 18px}
p{color:#7b8698;font-size:13px;line-height:1.6;margin:0}
</style></head><body><main>${body}</main></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findFile(name) {
  for (const dir of STATIC_DIRS) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (e) {
      // unreadable, keep looking
    }
  }
  return null;
}

/**
 * Signed-in visitors get the app. Everyone else gets the landing page, so a
 * single URL serves both without a redirect that would flash the wrong page.
 */
app.get('/', wrap(async (req, res) => {
  if (startupProblem) {
    return res.status(503).type('html').send(page('Landfall setup',
      `<h1>Landfall <span>setup</span></h1><pre>${escapeHtml(startupProblem)}</pre>
<p>Fix this under Environment on the Render web service, then redeploy.
This page replaces the app until startup succeeds.</p>`));
  }

  const user = await currentUser(req);
  if (!user) {
    const landing = findFile('landing.html');
    if (landing) return res.sendFile(landing);
  }

  const index = findIndexHtml();
  if (!index) {
    return res.status(500).type('html').send(page('Landfall',
      `<h1>Landfall</h1><pre>index.html was not found. Build ${BUILD}.

Searched:
${describeStaticDirs()}

Upload index.html to the repo root.</pre>
<p>Everything else started correctly.</p>`));
  }

  res.sendFile(index, (err) => {
    if (!err || res.headersSent) return;
    res.status(500).type('html').send(page('Landfall',
      `<h1>Landfall</h1><pre>Could not read ${escapeHtml(index)}. Build ${BUILD}.

${escapeHtml(err.message)}</pre>
<p>Everything else started correctly.</p>`));
  });
}));

/**
 * Listen first, then initialise. Binding the port before touching Postgres
 * means configuration errors surface as a readable page and readable logs
 * instead of a restart loop that swallows its own output.
 */
const server = app.listen(PORT, () => {
  console.log(`[server] Landfall build ${BUILD} listening on ${PORT}`);
  start();
});

async function start() {
  const problems = [];

  const missing = REQUIRED.filter(([name]) => !envValue(name));
  if (missing.length) {
    problems.push(
      'These environment variables are not set:\n\n' +
      missing.map(([name, hint]) => describeMissing(name, hint)).join('\n\n')
    );
  }

  const credProblem = google.credentialsProblem();
  if (credProblem) problems.push(credProblem);

  if (problems.length) {
    problems.push(envInventory());
    startupProblem = problems.join('\n\n');
    console.error('[server] not ready\n' + startupProblem);
    return;
  }

  const index = findIndexHtml();
  console.log(index
    ? `[server] console at ${index}`
    : `[server] warning: no index.html found. Searched:\n${describeStaticDirs()}`);

  try {
    await db.init();
    startupProblem = null;
    console.log(`[server] ready, signing as ${google.serviceAccountEmail()}`);
  } catch (err) {
    startupProblem = err && err.message ? err.message : String(err);
    console.error('[server] not ready: ' + startupProblem);
  }
}

process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err && err.message ? err.message : err);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
