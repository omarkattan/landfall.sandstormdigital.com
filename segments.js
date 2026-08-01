'use strict';

const { query } = require('./db');

/**
 * A segment is a named subset of a property's Search Console rows. Sitewide
 * numbers hide almost everything an algorithm update does, because updates
 * rarely move a whole site uniformly. Splitting traffic into populations that
 * behave differently is what makes "which part of the site was hit" answerable.
 *
 * Rules are stored rather than hard-coded so they can be corrected per client
 * without a deploy.
 */

const RULE_TYPES = new Set([
  'all',          // the whole property, from the 'total' slice
  'prefix',       // dim_value starts with pattern
  'contains',     // pattern appears anywhere
  'regex',        // case-insensitive POSIX regex
  'not_regex',    // inverse, used for non-branded
  'wordcount_gte' // long-tail queries, pattern is a number
]);

// Slice each segment kind reads from.
const SLICE_FOR_KIND = { total: 'total', page: 'page', query: 'query' };

// Postgres regular expressions are POSIX ARE, where \b means backspace rather
// than a word boundary. Matching an explicit space or end-of-string keeps the
// pattern readable for anyone editing it later.
const QUESTION_RE = '^(who|what|when|where|why|how|is|are|can|does|do|should|will|which)( |$)';
const COMMERCIAL_RE = '(best|top|review|reviews|vs|versus|compare|comparison|alternative|alternatives|pricing|price|cost|cheap|agency|agencies|service|services|company|companies|near me|hire|consultant)';

function assertRule(rule) {
  if (!RULE_TYPES.has(rule.rule_type)) {
    throw new Error(`Unknown rule type: ${rule.rule_type}`);
  }
  if (!SLICE_FOR_KIND[rule.kind]) {
    throw new Error(`Unknown segment kind: ${rule.kind}`);
  }
  if (rule.rule_type !== 'all' && !String(rule.pattern || '').trim()) {
    throw new Error('This rule type needs a pattern.');
  }
  if (rule.rule_type === 'wordcount_gte' && !Number.isFinite(Number(rule.pattern))) {
    throw new Error('wordcount_gte needs a number.');
  }
}

/**
 * Builds the WHERE fragment for a segment. Patterns are always bound as
 * parameters, never interpolated, since they are user-editable text.
 */
function predicate(rule, params) {
  switch (rule.rule_type) {
    case 'all':
      return 'true';
    case 'prefix':
      params.push(rule.pattern);
      return `dim_value like ($${params.length} || '%')`;
    case 'contains':
      params.push(rule.pattern);
      return `position($${params.length} in dim_value) > 0`;
    case 'regex':
      params.push(rule.pattern);
      return `dim_value ~* $${params.length}`;
    case 'not_regex':
      params.push(rule.pattern);
      return `dim_value !~* $${params.length}`;
    case 'wordcount_gte':
      params.push(parseInt(rule.pattern, 10));
      return `array_length(string_to_array(btrim(dim_value), ' '), 1) >= $${params.length}`;
    default:
      throw new Error(`Unknown rule type: ${rule.rule_type}`);
  }
}

/**
 * Daily totals for one segment. Clicks and impressions sum; position is
 * weighted by impressions, because an unweighted average of per-row positions
 * lets a single impression on page nine drag the number as hard as a thousand
 * impressions at position two.
 */
async function dailySeries(rule, fromDate, toDate) {
  assertRule(rule);

  const params = [rule.property_id, SLICE_FOR_KIND[rule.kind], fromDate, toDate];
  const where = predicate(rule, params);

  const sql = `
    select date::text as date,
           sum(clicks)::int as clicks,
           sum(impressions)::bigint as impressions,
           case when sum(impressions) > 0
                then sum(position * impressions) / sum(impressions)
                else null end as position
      from gsc_daily
     where property_id = $1
       and slice = $2
       and date between $3 and $4
       and ${where}
     group by date
     order by date`;

  const r = await query(sql, params);
  return r.rows.map((row) => ({
    date: row.date,
    clicks: Number(row.clicks) || 0,
    impressions: Number(row.impressions) || 0,
    position: row.position == null ? null : Number(row.position)
  }));
}

/**
 * Fills gaps so the weekly comparison lines up. A day with no rows is a real
 * zero for clicks, not missing data, and leaving it absent would silently
 * shift the same-weekday lookback by one slot.
 */
function densify(rows, fromDate, toDate) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out = [];
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);

  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    out.push(byDate.get(iso) || { date: iso, clicks: 0, impressions: 0, position: null });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

async function listSegments(propertyId) {
  const r = await query(
    `select * from segments where property_id = $1
      order by kind, sort_order, id`,
    [propertyId]
  );
  return r.rows;
}

async function createSegment(seg) {
  assertRule(seg);
  const r = await query(
    `insert into segments (property_id, kind, name, rule_type, pattern, sort_order, auto)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (property_id, kind, name) do update set
       rule_type = excluded.rule_type,
       pattern = excluded.pattern,
       sort_order = excluded.sort_order
     returning *`,
    [
      seg.property_id, seg.kind, seg.name, seg.rule_type,
      seg.rule_type === 'all' ? null : String(seg.pattern),
      seg.sort_order || 100,
      Boolean(seg.auto)
    ]
  );
  return r.rows[0];
}

async function deleteSegment(id, propertyId) {
  const r = await query(
    'delete from segments where id = $1 and property_id = $2 returning id',
    [id, propertyId]
  );
  return r.rowCount;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Brand terms drive the branded/non-branded split, which is the single most
 * important query cut. Branded demand tracks marketing and PR; non-branded
 * tracks rankings. Mixing them masks an algorithmic hit behind a brand
 * campaign, or the reverse.
 */
function brandRegexFor(terms) {
  const cleaned = (terms || [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map(escapeRegex);
  if (!cleaned.length) return null;
  return `(${cleaned.join('|')})`;
}

function guessBrandTerms(siteUrl) {
  const host = String(siteUrl)
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');

  const root = host.split('.')[0];
  const terms = new Set();
  if (root) {
    terms.add(root);
    // sandstormdigital -> also match "sandstorm digital"
    const split = root.replace(/([a-z])(digital|media|group|agency|labs|studio|co)$/i, '$1 $2');
    if (split !== root) terms.add(split);
  }
  return [...terms];
}

/**
 * Derives page groups from the site's own structure rather than a fixed
 * taxonomy. Takes the first path element of the highest-impression pages,
 * which matches how most sites are actually organised.
 */
async function derivePageGroups(propertyId, limit = 8) {
  const r = await query(
    `select dim_value, sum(impressions)::bigint as impressions
       from gsc_daily
      where property_id = $1 and slice = 'page'
        and date > current_date - interval '120 days'
      group by dim_value
      order by impressions desc
      limit 5000`,
    [propertyId]
  );

  const groups = new Map();
  let homeImpressions = 0;

  for (const row of r.rows) {
    let pathname;
    try {
      pathname = new URL(row.dim_value).pathname;
    } catch (e) {
      continue;
    }
    const impressions = Number(row.impressions) || 0;
    const first = pathname.split('/').filter(Boolean)[0];

    if (!first) {
      homeImpressions += impressions;
      continue;
    }
    groups.set(first, (groups.get(first) || 0) + impressions);
  }

  const ranked = [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const out = ranked.map(([segment, impressions], i) => ({
    name: segment.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    rule_type: 'contains',
    pattern: `/${segment}/`,
    impressions,
    sort_order: 20 + i
  }));

  if (homeImpressions > 0) {
    out.unshift({
      name: 'Homepage',
      rule_type: 'regex',
      pattern: '^https?://[^/]+/?$',
      impressions: homeImpressions,
      sort_order: 10
    });
  }

  return out;
}

/**
 * Creates a starting set of segments for a property. Safe to re-run: names are
 * unique per property and kind, so this updates rather than duplicates.
 */
async function autoCreate(propertyId, siteUrl, brandTerms) {
  const terms = (brandTerms && brandTerms.length) ? brandTerms : guessBrandTerms(siteUrl);
  const brandRe = brandRegexFor(terms);
  const created = [];

  created.push(await createSegment({
    property_id: propertyId, kind: 'total', name: 'All traffic',
    rule_type: 'all', sort_order: 0, auto: true
  }));

  const pageGroups = await derivePageGroups(propertyId);
  for (const g of pageGroups) {
    created.push(await createSegment({
      property_id: propertyId, kind: 'page', name: g.name,
      rule_type: g.rule_type, pattern: g.pattern, sort_order: g.sort_order, auto: true
    }));
  }

  if (brandRe) {
    created.push(await createSegment({
      property_id: propertyId, kind: 'query', name: 'Branded',
      rule_type: 'regex', pattern: brandRe, sort_order: 10, auto: true
    }));
    created.push(await createSegment({
      property_id: propertyId, kind: 'query', name: 'Non-branded',
      rule_type: 'not_regex', pattern: brandRe, sort_order: 11, auto: true
    }));
  }

  created.push(await createSegment({
    property_id: propertyId, kind: 'query', name: 'Questions',
    rule_type: 'regex', pattern: QUESTION_RE, sort_order: 12, auto: true
  }));
  created.push(await createSegment({
    property_id: propertyId, kind: 'query', name: 'Commercial intent',
    rule_type: 'regex', pattern: COMMERCIAL_RE, sort_order: 13, auto: true
  }));
  created.push(await createSegment({
    property_id: propertyId, kind: 'query', name: 'Long tail (4+ words)',
    rule_type: 'wordcount_gte', pattern: '4', sort_order: 14, auto: true
  }));

  return { created: created.length, brandTerms: terms };
}

module.exports = {
  RULE_TYPES,
  SLICE_FOR_KIND,
  dailySeries,
  densify,
  listSegments,
  createSegment,
  deleteSegment,
  autoCreate,
  derivePageGroups,
  guessBrandTerms,
  brandRegexFor,
  predicate,
  assertRule
};
