'use strict';

const { query } = require('./db');
const baseline = require('./baseline');

/**
 * Findings that do not depend on an algorithm update having happened.
 *
 * Update attribution only says something on the handful of days a year when an
 * update actually moved the site. The rest of the time the same data still
 * contains work worth doing: pages ranking just off the first page, listings
 * that rank well and are not being clicked, and content quietly decaying.
 *
 * Everything here is calibrated against the property's own history rather than
 * industry averages, because a B2B site in a niche vertical and a consumer
 * retailer have entirely different normal behaviour.
 */

const RECENT_DAYS = 28;

async function windowBounds(propertyId, days = RECENT_DAYS) {
  const r = await query(
    'select max(date)::text as last from gsc_daily where property_id = $1',
    [propertyId]
  );
  const last = r.rows[0] && r.rows[0].last;
  if (!last) return null;

  return {
    last,
    recentFrom: baseline.addDays(last, -(days - 1)),
    priorTo: baseline.addDays(last, -days),
    priorFrom: baseline.addDays(last, -(days * 2 - 1))
  };
}

/**
 * Aggregates one slice over a date window: clicks, impressions and an
 * impression-weighted average position per dimension value.
 */
async function aggregate(propertyId, slice, from, to) {
  const r = await query(
    `select dim_value,
            sum(clicks)::int as clicks,
            sum(impressions)::bigint as impressions,
            case when sum(impressions) > 0
                 then sum(position * impressions) / sum(impressions)
                 else null end as position
       from gsc_daily
      where property_id = $1 and slice = $2 and date between $3 and $4
      group by dim_value`,
    [propertyId, slice, from, to]
  );
  return r.rows.map((x) => ({
    key: x.dim_value,
    clicks: Number(x.clicks) || 0,
    impressions: Number(x.impressions) || 0,
    position: x.position == null ? null : Number(x.position)
  }));
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * The site's own click-through rate by position.
 *
 * Two decisions matter here. First, the reference is the seventieth percentile
 * within each position rather than the median, so "expected" means what a
 * well-written listing of yours achieves at that position, not the average of
 * good and bad ones. Second, a power law is fitted through those points rather
 * than using them directly, because on a small site a single underperforming
 * page can define a whole bucket and then never be flagged as underperforming.
 *
 * Using the property's real curve rather than a published one means the
 * comparison holds for unusual verticals and already accounts for however many
 * SERP features typically sit above this site's results.
 */
function ctrCurve(rows, minImpressions = 40) {
  const buckets = new Map();

  for (const r of rows) {
    if (r.position == null || r.impressions < minImpressions) continue;
    if (r.position > 20.5) continue;
    const p = Math.max(1, Math.min(20, Math.round(r.position)));
    if (!buckets.has(p)) buckets.set(p, []);
    buckets.get(p).push({ ctr: r.clicks / r.impressions, weight: r.impressions });
  }

  // One reference point per position, from the better performers in it.
  const points = [];
  for (const [p, entries] of buckets) {
    if (entries.length < 2) continue;
    const ctr = percentile(entries.map((e) => e.ctr), 0.7);
    if (ctr == null || ctr <= 0) continue;
    points.push({ p, ctr, weight: entries.reduce((s, e) => s + e.weight, 0) });
  }

  // Weighted least squares on log(ctr) = log(a) - b * log(position).
  let a = null, b = null;
  if (points.length >= 3) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const pt of points) {
      const w = Math.log10(pt.weight + 10);
      const x = Math.log(pt.p);
      const y = Math.log(pt.ctr);
      sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
    }
    const denom = sw * sxx - sx * sx;
    if (denom !== 0) {
      const slope = (sw * sxy - sx * sy) / denom;
      const intercept = (sy - slope * sx) / sw;
      b = Math.min(Math.max(-slope, 0.5), 1.8); // decay rate, kept plausible
      a = Math.exp(intercept);
    }
  }

  const curve = new Map();
  if (a != null && b != null) {
    for (let p = 1; p <= 20; p++) {
      curve.set(p, Math.min(Math.max(a * Math.pow(p, -b), 0.001), 0.65));
    }
    return curve;
  }

  // Too few positions to fit. Fall back to the observed points, filled
  // downward and held monotonic.
  const observed = new Map(points.map((pt) => [pt.p, pt.ctr]));
  let lastKnown = null;
  for (let p = 1; p <= 20; p++) {
    if (observed.has(p)) {
      const v = observed.get(p);
      curve.set(p, lastKnown != null && v > lastKnown ? lastKnown : v);
      lastKnown = curve.get(p);
    } else if (lastKnown != null) {
      curve.set(p, lastKnown * 0.72);
      lastKnown = curve.get(p);
    }
  }

  const firstKnown = [...curve.keys()].sort((x, y) => x - y)[0];
  if (firstKnown != null && firstKnown > 1) {
    let v = curve.get(firstKnown);
    for (let p = firstKnown - 1; p >= 1; p--) {
      v = v / 0.72;
      curve.set(p, Math.min(v, 0.6));
    }
  }
  return curve;
}

function expectedCtr(curve, position) {
  if (position == null) return null;
  const p = Math.max(1, Math.min(20, Math.round(position)));
  return curve.has(p) ? curve.get(p) : null;
}

/**
 * Queries ranking just off the top of page one. These are the cheapest wins
 * available, because the page already ranks and only needs to move a few
 * places rather than be created from nothing.
 *
 * Upside is measured against what this site earns at position three, since
 * that is a realistic target for something already in the top twenty. Using
 * the bottom of page one as the target would score a query at position five
 * as having nothing to gain.
 */
function strikingDistance(recent, curve, limit = 12) {
  const out = [];
  const target = expectedCtr(curve, 3);

  for (const r of recent) {
    if (r.position == null) continue;
    if (r.position < 3.5 || r.position > 20) continue;
    if (r.impressions < 50) continue;

    const currentCtr = r.impressions ? r.clicks / r.impressions : 0;
    if (target == null || target <= currentCtr) continue;

    out.push({
      ...r,
      currentCtr,
      targetCtr: target,
      upside: Math.round(r.impressions * (target - currentCtr))
    });
  }

  return out.sort((a, b) => b.upside - a.upside).slice(0, limit);
}

/**
 * Listings that rank where they should and are not being clicked. Once
 * position is controlled for, a large CTR shortfall points at either the
 * title and description or at something sitting above the organic result.
 */
function ctrShortfall(recent, curve, limit = 12) {
  const out = [];

  for (const r of recent) {
    if (r.position == null || r.position > 10.5) continue;
    if (r.impressions < 100) continue;

    const expected = expectedCtr(curve, r.position);
    if (expected == null || expected <= 0) continue;

    const actual = r.clicks / r.impressions;
    if (actual >= expected * 0.6) continue;

    out.push({
      ...r,
      actualCtr: actual,
      expectedCtr: expected,
      missedClicks: Math.round(r.impressions * (expected - actual))
    });
  }

  return out.sort((a, b) => b.missedClicks - a.missedClicks).slice(0, limit);
}

/**
 * Period-over-period movement per page. Content decay is gradual and never
 * trips an update-anchored comparison, which is exactly why it goes unnoticed.
 */
function movement(recent, prior, { minPrior = 10, limit = 12 } = {}) {
  const priorBy = new Map(prior.map((r) => [r.key, r]));
  const recentBy = new Map(recent.map((r) => [r.key, r]));
  const decliners = [];
  const risers = [];

  for (const [key, before] of priorBy) {
    if (before.clicks < minPrior) continue;
    const after = recentBy.get(key) || { clicks: 0, impressions: 0, position: null };
    const delta = after.clicks - before.clicks;
    const pct = (delta / before.clicks) * 100;

    const row = {
      key,
      before: before.clicks,
      after: after.clicks,
      delta,
      pct,
      positionBefore: before.position,
      positionAfter: after.position,
      positionDelta: (before.position != null && after.position != null)
        ? after.position - before.position : null
    };

    if (pct <= -25) decliners.push(row);
    else if (pct >= 30) risers.push(row);
  }

  return {
    decliners: decliners.sort((a, b) => a.delta - b.delta).slice(0, limit),
    risers: risers.sort((a, b) => b.delta - a.delta).slice(0, limit)
  };
}

function shortUrl(u) {
  try {
    const url = new URL(u);
    const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
    return path.length > 52 ? `${path.slice(0, 49)}...` : path;
  } catch (e) {
    return String(u).slice(0, 52);
  }
}

function pctStr(v) {
  if (v == null) return 'n/a';
  return `${v > 0 ? '+' : ''}${v.toFixed(0)}%`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Turns the raw lists into ranked, specific actions. Every recommendation
 * names the pages or queries it applies to, because advice without a target
 * is something nobody ever gets round to doing.
 */
function buildActions({ strikers, shortfalls, pageMove, queryMove, totals }) {
  const actions = [];

  if (strikers.length) {
    const top = strikers.slice(0, 5);
    const upside = strikers.reduce((s, r) => s + r.upside, 0);
    actions.push({
      priority: 'high',
      title: `${plural(strikers.length, 'query is', 'queries are')} one push from the top`,
      value: `about ${upside.toLocaleString()} more clicks a month`,
      body: `These rank between position 4 and 20, so the page already exists and Google already considers it relevant. Moving them into the top five is usually a matter of covering the query more directly: use the exact phrasing in a heading, answer it in the opening lines, and link to the page from your strongest related content. Start with the ones carrying the most impressions.`,
      items: top.map((r) => ({
        label: r.key,
        detail: `position ${r.position.toFixed(1)}, ${r.impressions.toLocaleString()} impressions, ${r.clicks} clicks`,
        value: `+${r.upside.toLocaleString()} potential`
      }))
    });
  }

  if (shortfalls.length) {
    const missed = shortfalls.reduce((s, r) => s + r.missedClicks, 0);
    actions.push({
      priority: 'high',
      title: `${plural(shortfalls.length, 'page ranks', 'pages rank')} well but ${shortfalls.length === 1 ? 'is' : 'are'} not being clicked`,
      value: `about ${missed.toLocaleString()} clicks left on the table`,
      body: `Each of these sits in the top ten yet earns well under what your own pages at that position normally earn. Two causes: the title and description are not answering the query, or something above the organic result is taking the click. Search each one yourself. If you see an AI Overview, the goal is to be its cited source, which means a direct answer in the first 60 words under a question-shaped heading. If the listing simply reads poorly, rewrite the title to lead with what the searcher asked for.`,
      items: shortfalls.slice(0, 5).map((r) => ({
        label: r.key,
        detail: `position ${r.position.toFixed(1)}, ${(r.actualCtr * 100).toFixed(1)}% click rate against your usual ${(r.expectedCtr * 100).toFixed(1)}%`,
        value: `${r.missedClicks.toLocaleString()} missed`
      }))
    });
  }

  if (pageMove.decliners.length) {
    const lost = pageMove.decliners.reduce((s, r) => s + r.delta, 0);
    const ranked = pageMove.decliners.filter((r) => r.positionDelta != null && r.positionDelta > 0.5).length;
    actions.push({
      priority: ranked >= pageMove.decliners.length / 2 ? 'high' : 'medium',
      title: `${plural(pageMove.decliners.length, 'page is', 'pages are')} decaying`,
      value: `${Math.abs(lost).toLocaleString()} clicks lost against the previous 28 days`,
      body: ranked >= pageMove.decliners.length / 2
        ? `These lost position as well as clicks, so they are being outranked rather than losing interest. Open the worst one, search its main query, and read what now sits above it. The usual gap is depth, freshness, or first-hand evidence the newer result has and yours does not.`
        : `These lost clicks without losing much position, which points at falling demand or a narrowing set of queries rather than a ranking problem. Check whether the topic is seasonal before rewriting anything, and compare which queries each page used to appear for against the ones it appears for now.`,
      items: pageMove.decliners.slice(0, 5).map((r) => ({
        label: shortUrl(r.key),
        detail: `${r.before} to ${r.after} clicks${r.positionDelta != null ? `, position ${r.positionDelta > 0 ? 'down' : 'up'} ${Math.abs(r.positionDelta).toFixed(1)}` : ''}`,
        value: pctStr(r.pct)
      }))
    });
  }

  if (queryMove.risers.length) {
    actions.push({
      priority: 'medium',
      title: `${plural(queryMove.risers.length, 'query is', 'queries are')} growing`,
      value: `${queryMove.risers.reduce((s, r) => s + r.delta, 0).toLocaleString()} clicks gained`,
      body: `Demand is moving toward these. Check whether each one has a page genuinely built for it or is being picked up incidentally by something broader. A query earning clicks against a page that only half answers it is the clearest case for new content there is, and it comes with evidence the audience already exists.`,
      items: queryMove.risers.slice(0, 5).map((r) => ({
        label: r.key,
        detail: `${r.before} to ${r.after} clicks`,
        value: pctStr(r.pct)
      }))
    });
  }

  if (totals && totals.brandedShare != null && totals.brandedShare > 60) {
    actions.push({
      priority: 'medium',
      title: 'Most search traffic is people already looking for you',
      value: `${totals.brandedShare.toFixed(0)}% branded`,
      body: `Branded search reflects marketing and reputation rather than rankings, so a high share means organic search is mostly harvesting demand created elsewhere rather than creating it. It also means a ranking problem can hide for months behind a healthy total. Track the non-branded line separately and treat it as the real measure of search performance.`,
      items: []
    });
  }

  return actions;
}

async function buildOpportunities(propertyId) {
  const bounds = await windowBounds(propertyId);
  if (!bounds) return { status: 'no_data', message: 'No stored data for this property yet.' };

  const [queriesRecent, queriesPrior, pagesRecent, pagesPrior] = await Promise.all([
    aggregate(propertyId, 'query', bounds.recentFrom, bounds.last),
    aggregate(propertyId, 'query', bounds.priorFrom, bounds.priorTo),
    aggregate(propertyId, 'page', bounds.recentFrom, bounds.last),
    aggregate(propertyId, 'page', bounds.priorFrom, bounds.priorTo)
  ]);

  if (!queriesRecent.length && !pagesRecent.length) {
    return { status: 'no_data', message: 'No query or page data in the last 28 days.' };
  }

  const curve = ctrCurve([...queriesRecent, ...pagesRecent]);
  const strikers = strikingDistance(queriesRecent, curve);
  const shortfalls = ctrShortfall(pagesRecent, curve);
  const pageMove = movement(pagesRecent, pagesPrior);
  const queryMove = movement(queriesRecent, queriesPrior);

  // Branded share, using the stored brand terms for this property.
  let brandedShare = null;
  const p = await query('select brand_terms from properties where id = $1', [propertyId]);
  const terms = p.rows[0] && p.rows[0].brand_terms
    ? p.rows[0].brand_terms.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  if (terms.length) {
    const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
    const total = queriesRecent.reduce((s, r) => s + r.clicks, 0);
    const branded = queriesRecent.filter((r) => re.test(r.key)).reduce((s, r) => s + r.clicks, 0);
    if (total > 0) brandedShare = (branded / total) * 100;
  }

  const totals = {
    clicks: queriesRecent.reduce((s, r) => s + r.clicks, 0),
    impressions: queriesRecent.reduce((s, r) => s + r.impressions, 0),
    brandedShare
  };

  const actions = buildActions({ strikers, shortfalls, pageMove, queryMove, totals });

  return {
    status: 'ok',
    window: { from: bounds.recentFrom, to: bounds.last, comparedWith: `${bounds.priorFrom} to ${bounds.priorTo}` },
    totals,
    curve: [...curve.entries()].map(([position, ctr]) => ({ position, ctr })),
    actions,
    counts: {
      strikers: strikers.length,
      shortfalls: shortfalls.length,
      decliningPages: pageMove.decliners.length,
      risingQueries: queryMove.risers.length
    }
  };
}

module.exports = {
  buildOpportunities,
  ctrCurve,
  strikingDistance,
  ctrShortfall,
  movement,
  aggregate
};
