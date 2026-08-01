'use strict';

/**
 * Seasonality-aware baseline for a daily metric.
 *
 * Search traffic has a strong weekly cycle: B2B sites collapse at weekends,
 * consumer sites peak there. Comparing a Tuesday against last Tuesday removes
 * that cycle without needing to model it. Medians rather than means, because a
 * single viral day or an outage should not move the expected range.
 *
 * Dispersion uses the median absolute deviation, scaled by 1.4826 so it
 * estimates the standard deviation of a normal distribution. That keeps the
 * band interpretable while staying robust to the outliers a mean would chase.
 */

const MAD_TO_SIGMA = 1.4826;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianAbsoluteDeviation(values, center) {
  if (!values.length) return null;
  const mid = center == null ? median(values) : center;
  return median(values.map((v) => Math.abs(v - mid)));
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param series  [{ date: 'YYYY-MM-DD', value: number }] ascending, gaps allowed
 * @param opts.lookbackWeeks how many same-weekday observations to consider
 * @param opts.minSamples    below this the day gets no expected range
 * @param opts.z             half-width of the band in estimated sigmas
 * @param opts.lowerIsBetter true for average position, where a fall is a gain
 */
function buildBaseline(series, opts = {}) {
  const {
    lookbackWeeks = 8,
    minSamples = 4,
    z = 1.96,
    lowerIsBetter = false
  } = opts;

  const byDate = new Map(series.map((p) => [p.date, p.value]));

  return series.map(({ date, value }) => {
    const history = [];
    for (let k = 1; k <= lookbackWeeks; k++) {
      const past = byDate.get(addDays(date, -7 * k));
      if (typeof past === 'number') history.push(past);
    }

    if (history.length < minSamples) {
      return {
        date,
        value,
        expected: null,
        lower: null,
        upper: null,
        samples: history.length,
        deviation: null,
        status: 'insufficient'
      };
    }

    const expected = median(history);
    const mad = medianAbsoluteDeviation(history, expected);
    let sigma = mad * MAD_TO_SIGMA;

    // A flat history gives MAD zero, which would make any movement look
    // infinitely significant. Fall back to a small proportional floor.
    const floor = Math.max(expected * 0.05, 1);
    if (!sigma || sigma < floor) sigma = floor;

    const lower = expected - z * sigma;
    const upper = expected + z * sigma;
    const deviation = (value - expected) / sigma;

    let status = 'normal';
    if (value > upper) status = lowerIsBetter ? 'below' : 'above';
    else if (value < lower) status = lowerIsBetter ? 'above' : 'below';

    return {
      date,
      value,
      expected,
      lower: Math.max(lower, lowerIsBetter ? 0 : 0),
      upper,
      samples: history.length,
      deviation,
      status
    };
  });
}

/**
 * Totals across a date window, with the same totals for the modelled
 * expectation. Used for "you should have done X, you did Y" statements.
 */
function summarise(points, fromDate, toDate) {
  const inRange = points.filter((p) => p.date >= fromDate && p.date <= toDate);
  const modelled = inRange.filter((p) => p.expected != null);

  const actual = inRange.reduce((s, p) => s + p.value, 0);
  const expected = modelled.reduce((s, p) => s + p.expected, 0);
  const lower = modelled.reduce((s, p) => s + p.lower, 0);
  const upper = modelled.reduce((s, p) => s + p.upper, 0);

  return {
    days: inRange.length,
    modelledDays: modelled.length,
    actual,
    expected: modelled.length ? expected : null,
    lower: modelled.length ? lower : null,
    upper: modelled.length ? upper : null,
    delta: modelled.length ? actual - expected : null,
    deltaPct: modelled.length && expected ? ((actual - expected) / expected) * 100 : null,
    daysBelow: inRange.filter((p) => p.status === 'below').length,
    daysAbove: inRange.filter((p) => p.status === 'above').length
  };
}

module.exports = {
  median,
  medianAbsoluteDeviation,
  buildBaseline,
  summarise,
  addDays,
  MAD_TO_SIGMA
};
