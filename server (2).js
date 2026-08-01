'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const PORT = process.env.PORT || 3000;
const TICK_BUDGET_MS = parseInt(process.env.TICK_BUDGET_MS || '45000', 10);

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
const STATIC_DIRS = [path.join(__dirname, 'public'), __dirname]
  .filter((d) => fs.existsSync(d));

function findIndexHtml() {
  for (const dir of STATIC_DIRS) {
    const candidate = path.join(dir, 'index.html');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
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
  res.json({ ok: !startupProblem, problem: startupProblem });
});

app.get('/api/setup', (req, res) => {
  res.json({ ready: !startupProblem, problem: startupProblem });
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

function requireAdmin(req, res, next) {
  if (req.cookies && req.cookies.lf_key === ADMIN_KEY) return next();
  return res.status(401).json({ error: 'Sign in to continue.' });
}

function requireCron(req, res) {
  const key = req.query.key || req.headers['x-cron-key'];
  if (key !== CRON_KEY) {
    res.status(401).json({ error: 'Bad cron key.' });
    return false;
  }
  return true;
}

app.post('/api/login', (req, res) => {
  const key = (req.body && req.body.key) || '';
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'That key does not match.' });

  res.cookie('lf_key', key, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('lf_key');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ signedIn: Boolean(req.cookies && req.cookies.lf_key === ADMIN_KEY) });
});

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
  const r = await db.query(
    `select j.id, j.slice, j.start_date, j.end_date, j.status, j.attempts,
            j.rows_written, j.error, p.site_url
       from ingest_jobs j join properties p on p.id = j.property_id
      where j.status in ('running','error')
      order by j.status, j.id desc
      limit 50`
  );
  res.json(r.rows);
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
// Source files are never exposed, since only /, /index.html and files the page
// actually requests are reachable, and the guard below blocks server code.
const BLOCKED = /\.(js|json|md|lock|env|sql)$/i;
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
main{max-width:600px}
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

app.get('/', (req, res) => {
  if (startupProblem) {
    return res.status(503).type('html').send(page('Landfall setup',
      `<h1>Landfall <span>setup</span></h1><pre>${escapeHtml(startupProblem)}</pre>
<p>Fix this under Environment on the Render web service, then redeploy.
This page replaces the app until startup succeeds.</p>`));
  }

  const index = findIndexHtml();
  if (!index) {
    return res.status(500).type('html').send(page('Landfall',
      `<h1>Landfall</h1><pre>index.html was not found.

Searched:
${STATIC_DIRS.map((d) => `  ${path.join(d, 'index.html')}`).join('\n')}

Upload index.html to the repo root or to a public/ folder.</pre>
<p>Everything else started correctly.</p>`));
  }

  res.sendFile(index);
});

/**
 * Listen first, then initialise. Binding the port before touching Postgres
 * means configuration errors surface as a readable page and readable logs
 * instead of a restart loop that swallows its own output.
 */
const server = app.listen(PORT, () => {
  console.log(`[server] Landfall listening on ${PORT}`);
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
    startupProblem = problems.join('\n\n');
    console.error('[server] not ready\n' + startupProblem);
    return;
  }

  const index = findIndexHtml();
  console.log(index ? `[server] console at ${index}` : '[server] warning: index.html not found');

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
