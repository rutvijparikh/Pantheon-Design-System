/**
 * Reads a W3C-style design tokens file (the `$value` / `$type` shape used by
 * `sample-tokens.json`) into flat lists the audit can search.
 *
 * Groups nest arbitrarily, so `colors.background.subtle` becomes one token with
 * the path `colors.background.subtle`. Keys beginning with `$` are group
 * metadata, not tokens.
 */
import { parseColor, toHex } from './color.js';

/** Token types we can compare a computed style against. */
const DIMENSION_TYPES = new Set(['number', 'dimension']);

/**
 * Walk the token tree depth-first and return every leaf that carries a
 * `$value`, tagged with its dotted path.
 */
export function flattenTokens(tree) {
  const tokens = [];

  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return;

    if (Object.hasOwn(node, '$value')) {
      tokens.push({
        path: trail.join('.'),
        name: trail[trail.length - 1],
        value: node.$value,
        type: node.$type ?? inferType(node.$value),
        description: node.$description ?? '',
      });
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue;
      walk(child, [...trail, key]);
    }
  };

  walk(tree, []);
  return tokens;
}

function inferType(value) {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string' && parseColor(value)) return 'color';
  return 'unknown';
}

/**
 * The CSS custom property a token should be referenced by.
 *
 * Path segments are kebab-cased, so the camelCase group `borderRadius.full`
 * becomes `--pantheon-border-radius-full` rather than carrying a capital into a
 * property name.
 */
export function cssVariable(path) {
  return `--pantheon-${path
    .split('.')
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
    .join('-')}`;
}

/**
 * Build the searchable index the audit runs against: colours pre-parsed to RGB,
 * dimensions pre-resolved to pixels and sorted so the nearest-match scan is a
 * simple linear pass over a small list.
 */
export function buildIndex(tree) {
  const tokens = flattenTokens(tree);
  const colors = [];
  const dimensions = [];

  for (const token of tokens) {
    if (token.type === 'color') {
      const rgb = parseColor(String(token.value));
      if (rgb) {
        colors.push({ ...token, rgb, hex: toHex(rgb), variable: cssVariable(token.path) });
      }
      continue;
    }
    if (DIMENSION_TYPES.has(token.type)) {
      const px = toPixels(token.value);
      if (px !== null) {
        dimensions.push({
          ...token,
          px,
          group: token.path.split('.')[0],
          variable: cssVariable(token.path),
        });
      }
    }
  }

  dimensions.sort((a, b) => a.px - b.px);
  return { tokens, colors, dimensions };
}

/** Token dimensions are unitless px numbers, or strings like `16px` / `1rem`. */
export function toPixels(value, rootFontSize = 16) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(-?[\d.]+)(px|rem|em)?$/);
  if (!match) return null;
  const amount = parseFloat(match[1]);
  if (Number.isNaN(amount)) return null;
  if (match[2] === 'rem' || match[2] === 'em') return amount * rootFontSize;
  return amount;
}

/**
 * Closest colour token by perceptual distance. `deltaE` is filled in by the
 * caller's comparator so this module stays free of the colour maths.
 */
export function nearestColor(rgb, index, compare) {
  let best = null;
  for (const token of index.colors) {
    const distance = compare(rgb, token.rgb);
    if (best === null || distance < best.deltaE) {
      best = { token, deltaE: distance };
    }
  }
  return best;
}

/**
 * Closest dimension token in pixels. When `group` is given ("spacing",
 * "borderRadius") the search is restricted to it, so a 6px gap is matched
 * against the spacing ramp rather than a radius that happens to be closer.
 */
export function nearestDimension(px, index, group = null) {
  const candidates = group
    ? index.dimensions.filter((token) => token.group === group)
    : index.dimensions;

  let best = null;
  for (const token of candidates) {
    const distance = Math.abs(token.px - px);
    if (best === null || distance < best.delta) {
      best = { token, delta: distance };
    }
  }
  return best;
}

/** Renders the whole token set as a `:root` block — the panel's export action. */
export function toCssVariables(tree) {
  const tokens = flattenTokens(tree);
  const lines = tokens.map((token) => {
    const value = DIMENSION_TYPES.has(token.type) ? `${toPixels(token.value)}px` : token.value;
    const comment = token.description ? ` /* ${token.description} */` : '';
    return `  ${cssVariable(token.path)}: ${value};${comment}`;
  });
  return `:root {\n${lines.join('\n')}\n}\n`;
}
