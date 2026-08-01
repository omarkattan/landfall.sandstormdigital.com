'use strict';

const { query, ensurePartitions } = require('./db');
const { searchAnalytics } = require('./google');

const TOP_N = parseInt(process.env.TOP_N || '500', 10);
const BACKFILL_MONTHS = parseInt(process.env.BACKFILL_MONTHS || '16', 10);
const REFRESH_DAYS = parseInt(process.env.REFRESH_DAYS || '14', 10);

// Search Console finalises data a few days late. Never ask for anything newer.
const DATA_LAG_DAYS = parseInt(process.env.DATA_LAG_DAYS || '3', 10);

// Slices pulled per property. 'perDay' slices make one request per day so we
// get a true top-N for each day rather than a top-N across the whole window.
const SLICES = {
  total: { dimensions: ['date'], perDay: false, rowLimit: 25000 },
  device: { dimensions: ['date', 'device'], perDay: false, rowLimit: 25000 },
  country: { dimensions: ['date', 'country'], perDay: false, rowLimit: 25000 },
  query: { dimensions: ['query'], perDay: true, rowLimit: TOP_N },
  page: { dimensions: ['page'], perDay: true, rowLimit: TOP_N }
};

const SLICE_NAMES = Object.keys(SLICES);

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function latestAvailableDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - DATA_LAG_DAYS);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function monthWindows(months) {
  const end = latestAvailableDate();
  const windows = [];
  for (let i = 0; i < months; i++) {
    const anchor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    const first = anchor;
    const lastOfMonth = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
    const last = lastOfMonth > end ? end : lastOfMonth;
    if (last < first) continue;
    windows.push({ start: iso(first), end: iso(last), priority: 200 + i });
  }
  return windows;
}

async function queueBackfill(propertyId) {
  const windows = monthWindows(BACKFILL_MONTHS);
  let queued = 0;
  for (const w of windows) {
    for (const slice of SLICE_NAMES) {
      const r = await query(
        `insert into ingest_jobs (property_id, slice, start_date, end_date, priority)
         values ($1, $2, $3, $4, $5)
         on conflict (property_id, slice, start_date, end_date) do nothing`,
        [propertyId, slice, w.start, w.end, w.priority]
      );
      queued += r.rowCount;
    }
  }
  await query('update properties set backfilled_at = null where id = $1', [propertyId]);
  return queued;
}

/**
 * Re-pulls a rolling recent window for every active property. Search Console
 * revises the last few days, so this upserts rather than appends.
 */
async function queueRefresh() {
  const end = latestAvailableDate();
  const start = addDays(end, -(REFRESH_DAYS - 1));
  const props = await query('select id from properties where active = true order by id');
  let queued = 0;

  for (const p of props.rows) {
    for (const slice of SLICE_NAMES) {
      const r = await query(
        `insert into ingest_jobs (property_id, slice, start_date, end_date, priority, status)
         values ($1, $2, $3, $4, 10, 'queued')
         on conflict (property_id, slice, start_date, end_date)
         do update set status = 'queued', priority = 10, error = null`,
        [p.id, slice, iso(start), iso(end)]
      );
      queued += r.rowCount;
    }
  }
  return queued;
}

function normaliseRows(slice, rows, fixedDate) {
  const cfg = SLICES[slice];
  const out = [];

  for (const row of rows) {
    const keys = row.keys || [];
    let date;
    let dimValue = '';

    if (cfg.perDay) {
      date = fixedDate;
      dimValue = keys[0] || '';
    } else {
      date = keys[0];
      dimValue = keys.length > 1 ? keys[1] || '' : '';
    }

    if (!date) continue;

    out.push({
      date,
      dimValue: String(dimValue).slice(0, 1000),
      clicks: Math.round(row.clicks || 0),
      impressions: Math.round(row.impressions || 0),
      position: row.position != null ? Number(row.position).toFixed(2) : null
    });
  }
  return out;
}

async function writeRows(propertyId, slice, rows) {
  if (!rows.length) return 0;

  const CHUNK = 500;
  let written = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];

    chunk.forEach((r, idx) => {
      const b = idx * 7;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
      params.push(propertyId, r.date, slice, r.dimValue, r.clicks, r.impressions, r.position);
    });

    await query(
      `insert into gsc_daily
         (property_id, date, slice, dim_value, clicks, impressions, position)
       values ${values.join(',')}
       on conflict (property_id, date, slice, dim_value) do update set
         clicks = excluded.clicks,
         impressions = excluded.impressions,
         position = excluded.position,
         updated_at = now()`,
      params
    );
    written += chunk.length;
  }
  return written;
}

async function runJob(job) {
  const cfg = SLICES[job.slice];
  if (!cfg) throw new Error(`Unknown slice: ${job.slice}`);

  const prop = await query('select site_url from properties where id = $1', [job.property_id]);
  if (!prop.rows[0]) throw new Error('Property no longer exists');
  const siteUrl = prop.rows[0].site_url;

  const start = new Date(`${iso(new Date(job.start_date))}T00:00:00Z`);
  const end = new Date(`${iso(new Date(job.end_date))}T00:00:00Z`);
  await ensurePartitions(start, end);

  let written = 0;

  if (cfg.perDay) {
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const day = iso(d);
      const rows = await searchAnalytics(siteUrl, {
        startDate: day,
        endDate: day,
        dimensions: cfg.dimensions,
        rowLimit: cfg.rowLimit
      });
      written += await writeRows(job.property_id, job.slice, normaliseRows(job.slice, rows, day));
    }
  } else {
    let startRow = 0;
    for (;;) {
      const rows = await searchAnalytics(siteUrl, {
        startDate: iso(start),
        endDate: iso(end),
        dimensions: cfg.dimensions,
        rowLimit: cfg.rowLimit,
        startRow
      });
      written += await writeRows(job.property_id, job.slice, normaliseRows(job.slice, rows));
      if (rows.length < cfg.rowLimit) break;
      startRow += cfg.rowLimit;
      if (startRow > 200000) break;
    }
  }

  return written;
}

async function claimJob() {
  const r = await query(
    `update ingest_jobs
        set status = 'running', started_at = now(), attempts = attempts + 1
      where id = (
        select id from ingest_jobs
         where status = 'queued'
         order by priority asc, id asc
         for update skip locked
         limit 1
      )
      returning *`
  );
  return r.rows[0] || null;
}

/**
 * Processes as many queued jobs as fit inside the time budget. Called by cron.
 */
async function runTick(budgetMs) {
  const deadline = Date.now() + budgetMs;
  const result = { processed: 0, failed: 0, rows: 0, remaining: 0 };

  while (Date.now() < deadline) {
    const job = await claimJob();
    if (!job) break;

    try {
      const written = await runJob(job);
      await query(
        `update ingest_jobs
            set status = 'done', finished_at = now(), rows_written = $2, error = null
          where id = $1`,
        [job.id, written]
      );
      result.processed += 1;
      result.rows += written;
    } catch (err) {
      const fatal = job.attempts >= 3;
      await query(
        `update ingest_jobs
            set status = $2, finished_at = now(), error = $3
          where id = $1`,
        [job.id, fatal ? 'error' : 'queued', String(err.message).slice(0, 500)]
      );
      result.failed += 1;
      console.error(`[ingest] job ${job.id} (${job.slice}) failed:`, err.message);
    }
  }

  const rem = await query(`select count(*)::int as n from ingest_jobs where status = 'queued'`);
  result.remaining = rem.rows[0].n;

  await query(
    `update properties p
        set backfilled_at = now()
      where p.backfilled_at is null
        and p.active = true
        and not exists (
          select 1 from ingest_jobs j
           where j.property_id = p.id and j.status in ('queued','running')
        )
        and exists (select 1 from ingest_jobs j where j.property_id = p.id)`
  );

  return result;
}

module.exports = { queueBackfill, queueRefresh, runTick, SLICE_NAMES, latestAvailableDate, iso };
