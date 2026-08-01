'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

function query(text, params) {
  return pool.query(text, params);
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

async function init() {
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

module.exports = { pool, query, init, ensurePartitions, getMeta, setMeta };
