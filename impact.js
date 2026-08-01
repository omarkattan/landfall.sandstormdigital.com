'use strict';

const { query } = require('./db');
const segmentsLib = require('./segments');
const baseline = require('./baseline');

/**
 * Attribution for a single ranking update.
 *
 * The rolling baseline in baseline.js adapts within about eight weeks, so by
 * the time you look, a step change has become the new normal. For attribution
 * the baseline must be frozen at the moment before the rollout started and
 * projected forward. Everything here works from that frozen expectation.
 *
 * Google's own guidance is to wait until a rollout completes, then compare a
 * window after against a window before. Windows are whole multiples of seven
 * days so both sides contain the same number of each weekday.
 */

const WINDOW_DAYS = 28;
const LOOKBACK_WEEKS = 8;
const MIN_POST_DAYS = 14;
const MIN_IMPRESSIONS = 200; // below this a segment is too small to judge

function iso(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Timestamps arrive as Date objects from the driver but as strings from JSON,
 * so both have to work. Everything downstream compares plain YYYY-MM-DD.
 */
function toDate(v) {
  if (v instanceof Date) {
    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  }
  const s = String(v);
  const day = s.slice(0, 10);
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Could not read the date "${s}" on this update.`);
    }
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  }
  return d;
}

function median(values) {
  return baseline.median(values);
}

/**
 * Expected value for each post-rollout day, using only same-weekday history
 * from before the rollout began.
 */
function frozenExpectation(history, postDates) {
  const byDate = new Map(history.map((h) => [h.date, h]));

  return postDates.map((date) => {
    const clicks = [];
    const impressions = [];
    for (let k = 1; k <= LOOKBACK_WEEKS; k++) {
      const past = byDate.get(baseline.addDays(date, -7 * k));
      if (past) {
        clicks.push(past.clicks);
        impressions.push(past.impressions);
      }
    }
    return {
      date,
      samples: clicks.length,
      clicks: clicks.length ? median(clicks) : null,
      impressions: impressions.length ? median(impressions) : null
    };
  });
}

function pct(actual, expected) {
  if (expected == null || expected === 0) return null;
  return ((actual - expected) / expected) * 100;
}

/**
 * The core diagnostic. Clicks alone cannot tell you what happened, but clicks
 * read against impressions and position can.
 *
 *   rankings fell        impressions down, position worse
 *   visibility withdrawn impressions down, position holding
 *   clicks siphoned      impressions holding, position holding, clicks down
 *   demand moved         impressions and clicks move together, position holding
 */
function diagnose({ clicksPct, imprPct, posDelta }) {
  const clicksDown = clicksPct != null && clicksPct <= -8;
  const clicksUp = clicksPct != null && clicksPct >= 8;
  const imprDown = imprPct != null && imprPct <= -8;
  const imprFlat = imprPct != null && Math.abs(imprPct) < 8;
  const posWorse = posDelta != null && posDelta >= 0.4;
  const posBetter = posDelta != null && posDelta <= -0.4;
  const posFlat = posDelta != null && Math.abs(posDelta) < 0.4;

  if (clicksDown && imprDown && posWorse) {
    return {
      code: 'ranking_loss',
      label: 'Rankings fell',
      detail: 'Fewer impressions and a worse average position. Pages are being shown less often and lower down, which is what a content quality reassessment looks like.'
    };
  }
  if (clicksDown && imprDown && posFlat) {
    return {
      code: 'visibility_loss',
      label: 'Shown for fewer searches',
      detail: 'Impressions fell while average position held. The pages still rank where they did, but Google is surfacing them for a narrower set of queries.'
    };
  }
  if (clicksDown && imprFlat && !posWorse) {
    return {
      code: 'ctr_loss',
      label: 'Clicks lost above the results',
      detail: 'Impressions and position held, but clicks fell. Something above the organic results is absorbing them, usually an AI Overview, a featured snippet, or more ads.'
    };
  }
  if (clicksDown && posWorse) {
    return {
      code: 'ranking_loss',
      label: 'Rankings fell',
      detail: 'Average position worsened enough to cost clicks.'
    };
  }
  if (clicksUp && posBetter) {
    return {
      code: 'ranking_gain',
      label: 'Rankings improved',
      detail: 'Better average position and more clicks. This segment gained from the update.'
    };
  }
  if (clicksUp) {
    return {
      code: 'gain',
      label: 'Gained',
      detail: 'Clicks came in above the expected range.'
    };
  }
  if (clicksDown) {
    return {
      code: 'unclear_loss',
      label: 'Clicks fell',
      detail: 'Clicks fell without a clear signal from impressions or position.'
    };
  }
  return {
    code: 'stable',
    label: 'Held steady',
    detail: 'Within the expected range for this period.'
  };
}

function listSegments(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * One recommendation per underlying cause, naming every segment it covers.
 * Repeating the same advice once per segment is how a useful finding turns
 * into a wall nobody reads.
 */
function recommendForGroup(code, group, update, propertyLabel) {
  const names = group.map((f) => f.name);
  const where = listSegments(names.slice(0, 4));
  const type = (update.update_type || '').toLowerCase();
  const out = [];

  if (code === 'ctr_loss') {
    out.push({
      priority: 'high',
      title: 'Win back the click',
      body: `${where} kept impressions and position but lost clicks, so the listing is still there and people are not choosing it. Take the top queries in these segments, run them yourself, and note what sits above the organic result. If it is an AI Overview, the goal is to be the source it cites: answer directly in the first 60 words, use question-shaped headings, and make factual claims attributable. If a competitor owns a featured snippet, match the format Google chose for the answer.`
    });
  }

  if (code === 'ranking_loss') {
    if (type.includes('spam')) {
      out.push({
        priority: 'high',
        title: 'Audit the link profile and publishing practices',
        body: `${where} lost position and impressions during a spam update. These target manipulation rather than quality. Export referring domains for the affected pages and look for anything bought, exchanged, or placed at scale. Check for content published at volume with little editing, and for third parties publishing on your domain, which is what site reputation abuse targets.`
      });
    } else {
      out.push({
        priority: 'high',
        title: 'Reassess content quality on the affected pages',
        body: `${where} lost both position and impressions. Core updates re-weigh how content is judged rather than penalising it, so there is nothing to remove, only something to improve. Take the 20 pages that lost the most clicks and ask what a reader gets there that they cannot get from the pages now outranking them. Look for thin coverage, pages competing with each other, missing first-hand evidence, and stale figures. Consolidating three weak pages into one strong one usually beats editing all three.`
      });
      out.push({
        priority: 'medium',
        title: 'Check substantiation on the affected pages',
        body: `Unsupported claims and undated statistics are a recurring weakness in content that core updates demote. Run the affected URLs through Claims Auditor to find claims with no source, outdated figures, and missing attribution, then fix the highest severity findings first.`
      });
    }
  }

  if (code === 'visibility_loss') {
    out.push({
      priority: 'high',
      title: 'Check indexing and query coverage',
      body: `${where} held average position but lost impressions, so these pages still rank where they did and are simply being shown for fewer searches. Open the Pages report in Search Console and look for a rise in Crawled not indexed or Discovered not indexed. Then compare the queries these segments used to appear for against the ones they appear for now. Losing a whole topic cluster looks exactly like this, and it usually means Google no longer considers the page a strong answer for that topic.`
    });
  }

  if (code === 'unclear_loss') {
    out.push({
      priority: 'medium',
      title: 'Investigate page by page',
      body: `${where} lost clicks without a clear signal from impressions or position, so there is no single obvious cause. Start with the worst-hit segment, list its top losing URLs, and compare each against what now outranks it.`
    });
  }

  return out;
}

async function assessUpdate(propertyId, update, options = {}) {
  const windowDays = options.windowDays || WINDOW_DAYS;

  const bounds = await query(
    'select min(date)::text as first, max(date)::text as last from gsc_daily where property_id = $1',
    [propertyId]
  );
  if (!bounds.rows[0] || !bounds.rows[0].last) return null;

  const dataFirst = bounds.rows[0].first;
  const dataLast = bounds.rows[0].last;

  const began = iso(toDate(update.began_at));
  const ended = update.ended_at ? iso(toDate(update.ended_at)) : began;

  // Post window opens the day after the rollout completes.
  const postStart = baseline.addDays(ended, 1);
  if (postStart > dataLast) {
    return { update, status: 'too_soon', message: 'This rollout has not finished long enough ago to measure.' };
  }

  let available = Math.round((toDate(dataLast) - toDate(postStart)) / 86400000) + 1;
  if (available < MIN_POST_DAYS) {
    return {
      update,
      status: 'too_soon',
      message: `Only ${available} day${available === 1 ? '' : 's'} of data since this rollout finished. At least ${MIN_POST_DAYS} are needed.`
    };
  }
  const postDays = Math.min(windowDays, Math.floor(available / 7) * 7);
  const postEnd = baseline.addDays(postStart, postDays - 1);

  // History for the frozen baseline: same weekdays before the rollout started.
  const histStart = baseline.addDays(began, -(LOOKBACK_WEEKS * 7 + 7));
  if (histStart < dataFirst) {
    const have = Math.round((toDate(began) - toDate(dataFirst)) / 86400000);
    if (have < 28) {
      return {
        update,
        status: 'no_history',
        message: `Only ${have} days of data before this rollout. At least 28 are needed to model what should have happened.`
      };
    }
  }
  const historyFrom = histStart < dataFirst ? dataFirst : histStart;

  const defs = await segmentsLib.listSegments(propertyId);
  if (!defs.length) {
    return { update, status: 'no_segments', message: 'Build segments first.' };
  }

  const postDates = [];
  for (let d = 0; d < postDays; d++) postDates.push(baseline.addDays(postStart, d));

  const findings = [];

  for (const rule of defs) {
    const histRaw = await segmentsLib.dailySeries(rule, historyFrom, baseline.addDays(began, -1));
    const history = segmentsLib.densify(histRaw, historyFrom, baseline.addDays(began, -1));

    const postRaw = await segmentsLib.dailySeries(rule, postStart, postEnd);
    const post = segmentsLib.densify(postRaw, postStart, postEnd);

    const expectation = frozenExpectation(history, postDates);
    const modelled = expectation.filter((e) => e.clicks != null);
    if (modelled.length < postDays * 0.7) continue;

    const actualClicks = post.reduce((s, p) => s + p.clicks, 0);
    const actualImpr = post.reduce((s, p) => s + p.impressions, 0);
    const expClicks = expectation.reduce((s, e) => s + (e.clicks || 0), 0);
    const expImpr = expectation.reduce((s, e) => s + (e.impressions || 0), 0);

    if (expImpr < MIN_IMPRESSIONS) continue;

    // Position is compared as a straight weighted average across each window.
    const prePos = weightedPosition(history.slice(-postDays));
    const postPos = weightedPosition(post);

    const clicksPct = pct(actualClicks, expClicks);
    const imprPct = pct(actualImpr, expImpr);
    const posDelta = (prePos != null && postPos != null) ? postPos - prePos : null;

    // Significance from day-level dispersion of the pre-period, so a noisy
    // segment needs a bigger move before it counts.
    const dailyExpected = expectation.map((e) => e.clicks || 0);
    const dailyActual = post.map((p) => p.clicks);
    const z = zScore(dailyActual, dailyExpected);

    const diagnosis = diagnose({ clicksPct, imprPct, posDelta });

    let verdict = 'stable';
    let confidence = 'low';
    if (clicksPct != null && z != null) {
      const magnitude = Math.abs(clicksPct);
      const strong = Math.abs(z) >= 2.5 && magnitude >= 10;
      const moderate = Math.abs(z) >= 1.5 && magnitude >= 8;
      if (clicksPct < 0 && (strong || moderate)) {
        verdict = 'hit';
        confidence = strong ? 'high' : 'moderate';
      } else if (clicksPct > 0 && (strong || moderate)) {
        verdict = 'gained';
        confidence = strong ? 'high' : 'moderate';
      }
    }

    findings.push({
      id: rule.id,
      kind: rule.kind,
      name: rule.name,
      actualClicks,
      expectedClicks: Math.round(expClicks),
      clicksPct,
      imprPct,
      posDelta,
      z,
      verdict,
      confidence,
      diagnosis
    });
  }

  return buildNarrative(propertyId, update, findings, {
    postStart, postEnd, postDays, historyFrom
  });
}

function weightedPosition(rows) {
  let num = 0, den = 0;
  for (const r of rows) {
    if (r.position == null || !r.impressions) continue;
    num += r.position * r.impressions;
    den += r.impressions;
  }
  return den ? num / den : null;
}

function zScore(actual, expected) {
  if (actual.length !== expected.length || !actual.length) return null;
  const diffs = actual.map((a, i) => a - expected[i]);
  const meanDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + Math.pow(d - meanDiff, 2), 0) / Math.max(diffs.length - 1, 1));
  if (!sd) return meanDiff === 0 ? 0 : (meanDiff > 0 ? 4 : -4);
  return (meanDiff / sd) * Math.sqrt(diffs.length);
}

function fmtPct(v) {
  if (v == null) return 'n/a';
  return `${v > 0 ? '+' : ''}${v.toFixed(0)}%`;
}

/**
 * Turns the findings into something a person can read and act on. Written as
 * templates rather than generated prose so the wording is auditable and the
 * same data always produces the same statement.
 */
async function buildNarrative(propertyId, update, findings, windowInfo) {
  const p = await query('select site_url, label from properties where id = $1', [propertyId]);
  const propertyLabel = p.rows[0] ? (p.rows[0].label || p.rows[0].site_url) : 'this site';

  const overall = findings.find((f) => f.kind === 'total');
  const parts = findings.filter((f) => f.kind !== 'total');
  const hits = parts.filter((f) => f.verdict === 'hit').sort((a, b) => a.clicksPct - b.clicksPct);
  const gains = parts.filter((f) => f.verdict === 'gained').sort((a, b) => b.clicksPct - a.clicksPct);
  const steady = parts.filter((f) => f.verdict === 'stable');

  const headline = [];
  const detail = [];

  const name = update.name;
  const window = `${windowInfo.postStart} to ${windowInfo.postEnd}`;

  if (!hits.length && !gains.length) {
    headline.push(`${name} did not move ${propertyLabel} in a way the data can distinguish from normal variation.`);
    detail.push(`Across the ${windowInfo.postDays} days after the rollout finished, every segment stayed inside its expected range. That is a real result, not an absence of one: it means this update is not the explanation for anything you are seeing.`);
  } else {
    if (overall && overall.clicksPct != null) {
      headline.push(`After ${name}, ${propertyLabel} took ${overall.actualClicks.toLocaleString()} clicks against an expected ${overall.expectedClicks.toLocaleString()}, a change of ${fmtPct(overall.clicksPct)}.`);
    } else {
      headline.push(`After ${name}, ${hits.length} segment${hits.length === 1 ? '' : 's'} of ${propertyLabel} moved outside the expected range.`);
    }

    if (hits.length) {
      const worst = hits.slice(0, 3)
        .map((f) => `${f.name} ${fmtPct(f.clicksPct)}`)
        .join(', ');
      detail.push(`The loss is concentrated in ${worst}.`);
    }
    if (gains.length) {
      detail.push(`${gains.slice(0, 2).map((f) => `${f.name} ${fmtPct(f.clicksPct)}`).join(' and ')} gained over the same window.`);
    }
  }

  // The selective-versus-uniform test is the most useful single inference
  // available from one search engine's data.
  let signature = null;
  if (hits.length && steady.length) {
    signature = {
      code: 'selective',
      title: 'This looks algorithmic, not technical',
      body: `${hits.length} segment${hits.length === 1 ? '' : 's'} fell while ${steady.length} held steady over the same days. A broken deploy, a robots.txt change, or a tracking fault takes everything down together. Selective movement like this is Google reassessing part of the site.`
    };
  } else if (hits.length && !steady.length && hits.length === parts.length && parts.length > 1) {
    signature = {
      code: 'uniform',
      title: 'Check for a technical cause before blaming the update',
      body: `Every segment fell by a similar amount over the same days. Updates rarely move a whole site uniformly. Before attributing this to ${name}, check what changed on your side around ${windowInfo.postStart}: deploys, redirects, robots.txt, canonical tags, or a Search Console property change.`
    };
  }

  // Group by cause, biggest loss first, so the most costly problem leads.
  const byCause = new Map();
  for (const f of hits) {
    const code = f.diagnosis.code;
    if (!byCause.has(code)) byCause.set(code, []);
    byCause.get(code).push(f);
  }

  const ordered = [...byCause.entries()].sort((a, b) => {
    const lost = (g) => g.reduce((s, f) => s + (f.expectedClicks - f.actualClicks), 0);
    return lost(b[1]) - lost(a[1]);
  });

  const recommendations = [];
  for (const [code, group] of ordered) {
    // Page and query segments overlap by definition, so counting a loss twice
    // would overstate it. Lead with pages, since that is where fixes are made.
    const pageFirst = [...group].sort((a, b) => {
      if (a.kind === b.kind) return a.clicksPct - b.clicksPct;
      return a.kind === 'page' ? -1 : 1;
    });
    recommendations.push(...recommendForGroup(code, pageFirst, update, propertyLabel));
  }

  const brandedHit = hits.some((f) => /^branded$/i.test(f.name));
  const nonBrandedHit = hits.some((f) => /non-branded/i.test(f.name));
  if (nonBrandedHit && !brandedHit) {
    recommendations.push({
      priority: 'medium',
      title: 'A healthy branded line is hiding this',
      body: `Non-branded traffic reflects rankings, branded reflects marketing. Non-branded fell while branded held, so the loss is in search performance rather than in interest in ${propertyLabel}. Report the two separately, or the sitewide number will understate the damage.`
    });
  }

  if (hits.length && !recommendations.length) {
    recommendations.push({
      priority: 'medium',
      title: 'Investigate page by page',
      body: `The drop is real but the metric pattern is mixed, so there is no single obvious cause. Start with the worst-hit segment and compare its top losing URLs against what now outranks them.`
    });
  }

  if (hits.length) {
    recommendations.push({
      priority: 'low',
      title: 'Re-measure in four weeks',
      body: `Record what you changed and when. Landfall keeps comparing against the expectation frozen before this rollout, so you can tell whether the fix worked rather than guessing.`
    });
  }

  return {
    update,
    status: 'assessed',
    window: windowInfo,
    headline: headline.join(' '),
    detail: detail.join(' '),
    signature,
    findings: [...(overall ? [overall] : []), ...hits, ...gains, ...steady],
    counts: { hit: hits.length, gained: gains.length, stable: steady.length },
    recommendations
  };
}

module.exports = { assessUpdate, diagnose, frozenExpectation, zScore, WINDOW_DAYS };
