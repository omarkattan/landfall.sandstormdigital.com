'use strict';

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Render internal hostnames have no dots (dpg-xxxxx-a) and take a plain
 * connection. External hostnames are fully qualified and need TLS.
 */
function needsSsl(url) {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return false;
    return host.includes('.');
  } catch (e) {
    return false;
  }
}

function configError(message) {
  const err = new Error(message);
  err.isConfigError = true;
  return err;
}

function buildPool() {
  if (!DATABASE_URL) {
    throw configError(
      'DATABASE_URL is not set. In Render, open your Postgres instance, copy the ' +
      'Internal Database URL, then add it as a DATABASE_URL environment variable ' +
      'on the web service.'
    );
  }

  let parsed;
  try {
    parsed = new URL(DATABASE_URL);
  } catch (e) {
    throw configError(
      'DATABASE_URL is not a valid connection string. It should look like ' +
      'postgresql://user:password@host/dbname'
    );
  }

  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw configError(
      `DATABASE_URL starts with "${parsed.protocol}" but should start with postgresql://`
    );
  }

  return new Pool({
    connectionString: DATABASE_URL,
    ssl: needsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
  });
}

let pool = null;

/**
 * Built on first use rather than at require time, so a bad connection string
 * is reported through init() as a readable message instead of a raw stack
 * trace thrown while the module is still loading.
 */
function getPool() {
  if (pool) return pool;
  pool = buildPool();
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message || err.code || String(err));
  });
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

const SCHEMA = `
create table if not exists properties (
  id serial primary key,
  site_url text unique not null,
  label text,
  property_type text not null default 'url_prefix',
  permission text,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  backfilled_at timestamptz
);

create table if not exists gsc_daily (
  property_id integer not null,
  date date not null,
  slice text not null,
  dim_value text not null default '',
  clicks integer not null default 0,
  impressions integer not null default 0,
  position numeric(6,2),
  updated_at timestamptz not null default now(),
  primary key (property_id, date, slice, dim_value)
) partition by range (date);

create table if not exists ingest_jobs (
  id bigserial primary key,
  property_id integer not null references properties(id) on delete cascade,
  slice text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'queued',
  priority integer not null default 100,
  attempts integer not null default 0,
  rows_written integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (property_id, slice, start_date, end_date)
);

create index if not exists ingest_jobs_claim_idx
  on ingest_jobs (status, priority, id);

create table if not exists algo_updates (
  id text primary key,
  engine text not null default 'google',
  name text not null,
  update_type text not null default 'other',
  status text,
  began_at timestamptz,
  ended_at timestamptz,
  url text,
  description text,
  source text not null default 'status_dashboard',
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists algo_updates_began_idx
  on algo_updates (began_at desc);

create table if not exists meta (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

create table if not exists segments (
  id serial primary key,
  property_id integer not null references properties(id) on delete cascade,
  kind text not null,
  name text not null,
  rule_type text not null,
  pattern text,
  sort_order integer not null default 100,
  auto boolean not null default false,
  created_at timestamptz not null default now(),
  unique (property_id, kind, name)
);

create index if not exists segments_property_idx on segments (property_id, kind, sort_order);

alter table properties add column if not exists brand_terms text;
`;

/**
 * gsc_daily is partitioned by month. Partitions must exist before an insert
 * touches that date, so we create a generous window at boot and top it up
 * whenever a job runs outside the covered range.
 */
async function ensurePartitions(fromDate, toDate) {
  const start = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), 1));

  const cursor = new Date(start);
  while (cursor <= end) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const next = new Date(Date.UTC(y, m + 1, 1));
    const name = `gsc_daily_${y}_${String(m + 1).padStart(2, '0')}`;
    const lower = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const upper = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;

    await query(
      `create table if not exists ${name}
       partition of gsc_daily
       for values from ('${lower}') to ('${upper}')`
    );
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
}

/**
 * Node reports a refused TCP connection as an AggregateError whose own message
 * is empty, which hides the real cause. Unwrap it into something readable.
 */
function describeDbError(err) {
  if (err && err.isConfigError) return err.message;

  const parts = [];
  const inner = err && Array.isArray(err.errors) ? err.errors : [err];

  for (const e of inner) {
    if (!e) continue;
    const message = e.message || '';
    const socket = e.address ? `${e.address}:${e.port}` : '';
    const bits = [
      e.code && !message.includes(e.code) ? e.code : null,
      message || null,
      socket && !message.includes(socket) ? socket : null
    ].filter(Boolean);
    if (bits.length) parts.push(bits.join(' '));
  }

  const detail = parts.length ? parts.join('; ') : 'no detail reported';
  let host = 'unknown host';
  try {
    host = new URL(DATABASE_URL).hostname;
  } catch (e) {
    // leave the fallback
  }

  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/.test(detail)) {
    return (
      `Could not reach Postgres at "${host}". ${detail}. ` +
      `Check that DATABASE_URL holds your Render Postgres Internal Database URL ` +
      `and that the database and web service sit in the same region.`
    );
  }
  if (/password|authentication|role .* does not exist/i.test(detail)) {
    return `Postgres rejected the credentials in DATABASE_URL. ${detail}`;
  }
  if (/self.signed|certificate|SSL/i.test(detail)) {
    return `TLS negotiation with Postgres failed. ${detail}`;
  }
  return `Postgres connection failed. ${detail}`;
}

async function connectWithRetry(attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const client = await getPool().connect();
      client.release();
      return;
    } catch (err) {
      const message = describeDbError(err);
      // A bad connection string will never fix itself, so do not retry it.
      if (err && err.isConfigError) throw new Error(message);
      if (i === attempts) throw new Error(message);
      const wait = Math.min(1000 * Math.pow(2, i - 1), 8000);
      console.warn(`[db] attempt ${i} of ${attempts} failed: ${message}`);
      console.warn(`[db] retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function init() {
  await connectWithRetry();
  console.log('[db] connected');

  await query(SCHEMA);

  const now = new Date();
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - 20);
  const to = new Date(now);
  to.setUTCMonth(to.getUTCMonth() + 2);

  await ensurePartitions(from, to);
  console.log('[db] schema ready');
}

async function getMeta(key) {
  const r = await query('select value from meta where key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function setMeta(key, value) {
  await query(
    `insert into meta (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, String(value)]
  );
}

module.exports = {
  getPool,
  query,
  init,
  ensurePartitions,
  getMeta,
  setMeta,
  describeDbError
};
