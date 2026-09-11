/**
 * Turns raw style usage collected from a page into design-system findings.
 *
 * The page-side collector does the DOM work and reports what values are in use;
 * everything judgmental — is this value one of ours, which token should it have
 * been, how bad is the gap — happens here, against the token index.
 */
import { contrastRatio, deltaE, flatten, formatColor, parseColor, toHex } from './color.js';
import { nearestColor, nearestDimension, toPixels } from './tokens.js';

/**
 * Perceptual distance bands. A page rarely reproduces a token byte-for-byte —
 * antialiasing, opacity and colour-space conversion all nudge the value — so
 * anything under EXACT counts as on-token, and the band above it is a near miss
 * worth snapping rather than a real violation.
 */
export const COLOR_THRESHOLD = {
  EXACT: 1.0,
  NEAR: 3.0,
  // Past roughly 10 ΔE two colours read as different hues, so naming a
  // "nearest token" stops being a suggestion and starts being misleading.
  SUGGESTABLE: 10.0,
};

/** Pixel slack before a dimension stops being a rounding artefact. */
export const DIMENSION_THRESHOLD = {
  EXACT: 0.5,
  NEAR: 2.0,
};

/** WCAG 2.1 AA/AAA minimums. */
export const CONTRAST = { AA: 4.5, AA_LARGE: 3.0, AAA: 7.0 };

let sequence = 0;
const nextId = () => `f${++sequence}`;

/**
 * Classify one colour against the palette.
 * Returns `null` when the value carries no colour (transparent, `currentColor`).
 */
export function classifyColor(value, index) {
  const parsed = parseColor(value);
  if (!parsed || parsed.a === 0) return null;

  const opaque = flatten(parsed);
  const nearest = nearestColor(opaque, index, deltaE);
  if (!nearest) return null;

  const { token, deltaE: distance } = nearest;
  if (distance <= COLOR_THRESHOLD.EXACT) {
    return { status: 'on-token', token, deltaE: distance, actual: formatColor(parsed) };
  }
  if (distance <= COLOR_THRESHOLD.NEAR) {
    return { status: 'near', token, deltaE: distance, actual: formatColor(parsed) };
  }
  return {
    status: 'off-token',
    token: distance <= COLOR_THRESHOLD.SUGGESTABLE ? token : null,
    deltaE: distance,
    actual: formatColor(parsed),
  };
}

/** Classify one pixel dimension against a token ramp. */
export function classifyDimension(px, index, group) {
  if (typeof px !== 'number' || Number.isNaN(px)) return null;
  if (px === 0) return { status: 'on-token', token: null, delta: 0, actual: '0' };

  const nearest = nearestDimension(px, index, group);
  if (!nearest) return null;

  const { token, delta } = nearest;
  if (delta <= DIMENSION_THRESHOLD.EXACT) {
    return { status: 'on-token', token, delta, actual: `${px}px` };
  }
  if (delta <= DIMENSION_THRESHOLD.NEAR) {
    return { status: 'near', token, delta, actual: `${px}px` };
  }
  return { status: 'off-token', token, delta, actual: `${px}px` };
}

const severityFor = (status) =>
  status === 'off-token' ? 'error' : status === 'near' ? 'warning' : 'info';

function colorFinding({ property, verdict, count, examples }) {
  const { status, token, deltaE: distance, actual } = verdict;
  if (status === 'on-token') return null;

  const message =
    status === 'near'
      ? `${actual} is ${distance.toFixed(1)} ΔE from ${token.path} — close enough to be a drifted copy of it.`
      : token
        ? `${actual} is not in the palette. Nearest token is ${token.path} (${token.hex}), ${distance.toFixed(1)} ΔE away.`
        : `${actual} is not in the palette and nothing in it is close.`;

  return {
    id: nextId(),
    severity: severityFor(status),
    category: 'color',
    property,
    actual,
    expected: token ? token.hex : null,
    token: token ? token.path : null,
    variable: token ? token.variable : null,
    distance: Number(distance.toFixed(2)),
    unit: 'ΔE',
    message,
    count,
    examples,
  };
}

function dimensionFinding({ property, category, group, verdict, count, examples }) {
  const { status, token, delta, actual } = verdict;
  if (status === 'on-token') return null;

  const message =
    status === 'near'
      ? `${actual} is ${delta}px off ${token.path} (${token.px}px) — snap it to the token.`
      : `${actual} is off the ${group} ramp. Nearest token is ${token.path} (${token.px}px).`;

  return {
    id: nextId(),
    severity: severityFor(status),
    category,
    property,
    actual,
    expected: `${token.px}px`,
    token: token.path,
    variable: token.variable,
    distance: Number(delta.toFixed(2)),
    unit: 'px',
    message,
    count,
    examples,
  };
}

/**
 * Audit a single element captured by the inspector.
 * `sample` is the shape produced by the page-side collector.
 */
export function auditElement(sample, index) {
  const findings = [];
  const add = (finding) => finding && findings.push(finding);
  const examples = [sample.selector];

  for (const [property, value] of Object.entries(sample.colors ?? {})) {
    const verdict = classifyColor(value, index);
    if (verdict) add(colorFinding({ property, verdict, count: 1, examples }));
  }

  for (const [property, value] of Object.entries(sample.spacing ?? {})) {
    const verdict = classifyDimension(toPixels(value), index, 'spacing');
    if (verdict) {
      add(dimensionFinding({ property, category: 'spacing', group: 'spacing', verdict, count: 1, examples }));
    }
  }

  for (const [property, value] of Object.entries(sample.radii ?? {})) {
    const verdict = classifyDimension(toPixels(value), index, 'borderRadius');
    if (verdict) {
      add(dimensionFinding({ property, category: 'radius', group: 'borderRadius', verdict, count: 1, examples }));
    }
  }

  const contrast = auditContrastPair(sample.contrast);
  if (contrast) findings.push({ ...contrast, examples });

  return { findings: sortFindings(findings), summary: summarize(findings) };
}

/**
 * Contrast check for one foreground/background pair. Large text (>=24px, or
 * >=18.66px bold) is held to the lower AA threshold, per WCAG.
 */
export function auditContrastPair(pair) {
  if (!pair?.foreground || !pair?.background) return null;

  const foreground = flatten(parseColor(pair.foreground), parseColor(pair.background) ?? undefined);
  const background = flatten(parseColor(pair.background));
  if (!foreground || !background) return null;

  const ratio = contrastRatio(foreground, background);
  const fontSize = toPixels(pair.fontSize) ?? 16;
  const weight = Number(pair.fontWeight) || 400;
  const isLarge = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
  const minimum = isLarge ? CONTRAST.AA_LARGE : CONTRAST.AA;
  const scale = isLarge ? 'large text' : 'body text';

  if (ratio >= CONTRAST.AAA) return null;

  const passes = ratio >= minimum;
  return {
    id: nextId(),
    severity: passes ? 'info' : 'error',
    category: 'contrast',
    property: 'color / background-color',
    actual: `${ratio.toFixed(2)}:1`,
    expected: `${passes ? CONTRAST.AAA : minimum}:1`,
    token: null,
    variable: null,
    distance: Number(ratio.toFixed(2)),
    unit: ':1',
    message: passes
      ? `${toHex(foreground)} on ${toHex(background)} is ${ratio.toFixed(2)}:1 — passes AA for ${scale}, short of AAA (7:1).`
      : `${toHex(foreground)} on ${toHex(background)} is ${ratio.toFixed(2)}:1 — fails WCAG AA for ${scale} (needs ${minimum}:1).`,
    count: 1,
    examples: [],
  };
}

/**
 * Audit an aggregated page scan. Findings are deduplicated by value and carry
 * the number of elements affected, so the panel can lead with the drift that
 * shows up most.
 */
export function auditPage(scan, index) {
  const findings = [];
  const add = (finding) => finding && findings.push(finding);

  for (const usage of scan.colors ?? []) {
    const verdict = classifyColor(usage.value, index);
    if (!verdict) continue;
    add(
      colorFinding({
        property: usage.properties?.join(', ') ?? 'color',
        verdict,
        count: usage.count,
        examples: usage.examples ?? [],
      }),
    );
  }

  for (const usage of scan.spacing ?? []) {
    const verdict = classifyDimension(toPixels(usage.value), index, 'spacing');
    if (!verdict) continue;
    add(
      dimensionFinding({
        property: usage.properties?.join(', ') ?? 'padding',
        category: 'spacing',
        group: 'spacing',
        verdict,
        count: usage.count,
        examples: usage.examples ?? [],
      }),
    );
  }

  for (const usage of scan.radii ?? []) {
    const verdict = classifyDimension(toPixels(usage.value), index, 'borderRadius');
    if (!verdict) continue;
    add(
      dimensionFinding({
        property: usage.properties?.join(', ') ?? 'border-radius',
        category: 'radius',
        group: 'borderRadius',
        verdict,
        count: usage.count,
        examples: usage.examples ?? [],
      }),
    );
  }

  for (const pair of scan.contrast ?? []) {
    const finding = auditContrastPair(pair);
    if (finding) {
      findings.push({ ...finding, count: pair.count ?? 1, examples: pair.examples ?? [] });
    }
  }

  // Typography is reported rather than judged: the sample token file carries no
  // type ramp, so the panel shows the families and sizes in play and lets Claude
  // reason about whether they belong.
  const typography = {
    families: scan.fontFamilies ?? [],
    sizes: scan.fontSizes ?? [],
    shadows: scan.shadows ?? [],
  };

  return {
    findings: sortFindings(findings),
    summary: summarize(findings),
    coverage: coverage(scan, index),
    typography,
    elementsScanned: scan.elementsScanned ?? 0,
  };
}

/**
 * Share of style usages that already sit on a token, weighted by how many
 * elements use each value — one stray colour on a single div should not read
 * the same as one on four hundred.
 */
export function coverage(scan, index) {
  const tally = (usages, classify) => {
    let onToken = 0;
    let total = 0;
    for (const usage of usages ?? []) {
      const verdict = classify(usage.value);
      if (!verdict) continue;
      total += usage.count;
      if (verdict.status === 'on-token') onToken += usage.count;
    }
    return { onToken, total };
  };

  const colors = tally(scan.colors, (value) => classifyColor(value, index));
  const spacing = tally(scan.spacing, (value) =>
    classifyDimension(toPixels(value), index, 'spacing'),
  );
  const radii = tally(scan.radii, (value) =>
    classifyDimension(toPixels(value), index, 'borderRadius'),
  );

  const percent = ({ onToken, total }) => (total === 0 ? null : Math.round((onToken / total) * 100));
  const overall = {
    onToken: colors.onToken + spacing.onToken + radii.onToken,
    total: colors.total + spacing.total + radii.total,
  };

  return {
    color: percent(colors),
    spacing: percent(spacing),
    radius: percent(radii),
    overall: percent(overall),
  };
}

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.count ?? 1) - (a.count ?? 1) ||
      (b.distance ?? 0) - (a.distance ?? 0),
  );
}

function summarize(findings) {
  const summary = { errors: 0, warnings: 0, infos: 0, elementsAffected: 0 };
  for (const finding of findings) {
    if (finding.severity === 'error') summary.errors += 1;
    else if (finding.severity === 'warning') summary.warnings += 1;
    else summary.infos += 1;
    summary.elementsAffected += finding.count ?? 1;
  }
  return summary;
}
