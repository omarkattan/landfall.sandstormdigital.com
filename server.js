'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./db');
const { listSites, serviceAccountEmail } = require('./google');
const ingest = require('./ingest');
const updates = require('./updates');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const ADMIN_KEY = process.env.ADMIN_KEY || '';
const CRON_KEY = process.env.CRON_KEY || '';
const TICK_BUDGET_MS = parseInt(process.env.TICK_BUDGET_MS || '45000', 10);
const PORT = process.env.PORT || 3000;

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: 'ADMIN_KEY is not configured on the server.' });
  }
  if (req.cookies && req.cookies.ar_key === ADMIN_KEY) return next();
  return res.status(401).json({ error: 'Sign in to continue.' });
}

function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[api]', err.message);
      res.status(500).json({ error: err.message });
    });
  };
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  const key = (req.body && req.body.key) || '';
  if (!ADMIN_KEY) return res.status(500).json({ error: 'ADMIN_KEY is not configured on the server.' });
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'That key does not match.' });

  res.cookie('ar_key', key, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('ar_key');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ signedIn: Boolean(req.cookies && req.cookies.ar_key === ADMIN_KEY) });
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
    serviceAccount: serviceAccountEmail(),
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
  const sites = await listSites();
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

/**
 * Cron entry point. Authenticated with CRON_KEY so it can be called by
 * cron-job.org without a browser session.
 */
app.all('/api/ingest', wrap(async (req, res) => {
  const key = req.query.key || req.headers['x-cron-key'];
  if (!CRON_KEY || key !== CRON_KEY) {
    return res.status(401).json({ error: 'Bad cron key.' });
  }
  const budget = Math.min(parseInt(req.query.budget || TICK_BUDGET_MS, 10), 120000);
  const result = await ingest.runTick(budget);
  res.json(result);
}));

/**
 * Nightly queue top-up. Point a second cron at this once a day.
 */
app.all('/api/cron/refresh', wrap(async (req, res) => {
  const key = req.query.key || req.headers['x-cron-key'];
  if (!CRON_KEY || key !== CRON_KEY) {
    return res.status(401).json({ error: 'Bad cron key.' });
  }
  const queued = await ingest.queueRefresh();
  let synced = null;
  try {
    synced = await updates.syncGoogleUpdates();
  } catch (err) {
    synced = { error: err.message };
  }
  res.json({ queued, updates: synced });
}));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] listening on ${PORT}`));
  })
  .catch((err) => {
    console.error('[server] failed to start:', err.message);
    process.exit(1);
  });
