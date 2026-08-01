'use strict';

const { query, setMeta } = require('./db');

// Google Search Status Dashboard publishes a machine readable incident history.
// The Ranking product carries the algorithm update announcements.
const INCIDENTS_URL = 'https://status.search.google.com/incidents.json';
const RANKING_PRODUCT_ID = 'rGHU1u87FJnkP6W2GwMi';
const INCIDENT_BASE = 'https://status.search.google.com/';

function classify(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('spam')) return 'spam';
  if (n.includes('core')) return 'core';
  if (n.includes('helpful')) return 'helpful_content';
  if (n.includes('review')) return 'reviews';
  if (n.includes('site reputation')) return 'site_reputation';
  if (n.includes('ranking')) return 'ranking';
  return 'other';
}

function isRanking(incident) {
  const products = incident.affected_products || incident.affectedProducts || [];
  if (products.some((p) => p && (p.id === RANKING_PRODUCT_ID || /ranking/i.test(p.title || '')))) {
    return true;
  }
  if (incident.service_key === RANKING_PRODUCT_ID) return true;
  if (/ranking/i.test(incident.service_name || '')) return true;
  return false;
}

function toTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function describe(incident) {
  const recent = incident.most_recent_update || incident.mostRecentUpdate;
  if (recent && recent.text) return String(recent.text).slice(0, 4000);
  const updates = incident.updates || [];
  if (updates.length && updates[0].text) return String(updates[0].text).slice(0, 4000);
  return null;
}

async function upsertUpdate(row) {
  await query(
    `insert into algo_updates
       (id, engine, name, update_type, status, began_at, ended_at, url, description, source, raw, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     on conflict (id) do update set
       name = excluded.name,
       update_type = excluded.update_type,
       status = excluded.status,
       began_at = excluded.began_at,
       ended_at = excluded.ended_at,
       url = excluded.url,
       description = excluded.description,
       raw = excluded.raw,
       updated_at = now()`,
    [
      row.id,
      row.engine || 'google',
      row.name,
      row.update_type || classify(row.name),
      row.status || null,
      row.began_at || null,
      row.ended_at || null,
      row.url || null,
      row.description || null,
      row.source || 'status_dashboard',
      row.raw ? JSON.stringify(row.raw) : null
    ]
  );
}

async function syncGoogleUpdates() {
  let incidents;
  try {
    const res = await fetch(INCIDENTS_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'algo-radar/0.1' }
    });
    if (!res.ok) throw new Error(`status dashboard responded ${res.status}`);
    incidents = await res.json();
  } catch (err) {
    await setMeta('updates_last_error', err.message);
    throw new Error(
      `Could not read the Google Search Status Dashboard: ${err.message}. ` +
      `Add updates by hand under Updates while this is failing.`
    );
  }

  if (!Array.isArray(incidents)) {
    throw new Error('Status dashboard returned an unexpected shape. Expected an array of incidents.');
  }

  const ranking = incidents.filter(isRanking);
  let written = 0;

  for (const incident of ranking) {
    const id = String(incident.id || incident.number || '').trim();
    if (!id) continue;

    const name = incident.external_desc || incident.externalDesc || incident.service_name || 'Unnamed ranking update';
    const uri = incident.uri || `incidents/${id}`;

    await upsertUpdate({
      id: `google:${id}`,
      engine: 'google',
      name,
      update_type: classify(name),
      status: incident.status_impact || incident.severity || null,
      began_at: toTimestamp(incident.begin || incident.created),
      ended_at: toTimestamp(incident.end),
      url: uri.startsWith('http') ? uri : `${INCIDENT_BASE}${uri}`,
      description: describe(incident),
      source: 'status_dashboard',
      raw: incident
    });
    written += 1;
  }

  await setMeta('updates_last_sync', new Date().toISOString());
  await setMeta('updates_last_error', '');
  return { seen: incidents.length, ranking: ranking.length, written };
}

async function addManualUpdate({ name, update_type, began_at, ended_at, url, description, engine }) {
  if (!name || !began_at) {
    throw new Error('An update needs at least a name and a start date.');
  }
  const id = `manual:${Date.now()}`;
  await upsertUpdate({
    id,
    engine: engine || 'google',
    name,
    update_type: update_type || classify(name),
    status: 'manual',
    began_at: toTimestamp(began_at),
    ended_at: toTimestamp(ended_at),
    url: url || null,
    description: description || null,
    source: 'manual'
  });
  return id;
}

async function listUpdates(limit = 60) {
  const r = await query(
    `select id, engine, name, update_type, status, began_at, ended_at, url, source
       from algo_updates
      order by began_at desc nulls last
      limit $1`,
    [limit]
  );
  return r.rows;
}

module.exports = { syncGoogleUpdates, addManualUpdate, listUpdates, classify };
