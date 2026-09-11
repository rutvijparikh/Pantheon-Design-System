/**
 * Colour parsing and perceptual comparison.
 *
 * The audit needs to answer "is this colour one of ours?", and string equality
 * cannot: the same token shows up as `#0066FF`, `rgb(0, 102, 255)` and
 * `color(srgb 0 0.4 1)` depending on how the page authored it and how Chrome
 * resolved it. So every colour is normalised to RGB and compared in CIELAB with
 * CIEDE2000, which tracks how different two colours actually look.
 */

/** CSS named colours that show up often enough in real stylesheets to matter. */
const NAMED = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  purple: { r: 128, g: 0, b: 128, a: 1 },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Parse any colour string Chrome's computed styles or a token file can produce.
 * Returns `null` for keywords we cannot resolve (`currentColor`, `inherit`) so
 * callers can skip them rather than audit a guess.
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;

  if (Object.hasOwn(NAMED, value)) return { ...NAMED[value] };

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const expand = (char) => parseInt(char + char, 16);
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]),
        g: expand(hex[1]),
        b: expand(hex[2]),
        a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      const byte = (index) => parseInt(hex.slice(index, index + 2), 16);
      if (Number.isNaN(byte(0))) return null;
      return {
        r: byte(0),
        g: byte(2),
        b: byte(4),
        a: hex.length === 8 ? byte(6) / 255 : 1,
      };
    }
    return null;
  }

  // rgb()/rgba() — legacy comma syntax and modern space syntax, percentages included.
  const rgb = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part) =>
      part.endsWith('%') ? (parseFloat(part) / 100) * 255 : parseFloat(part);
    const alpha = parts[3] === undefined ? 1 : parseAlpha(parts[3]);
    const [r, g, b] = parts.slice(0, 3).map(channel);
    if ([r, g, b, alpha].some(Number.isNaN)) return null;
    return {
      r: clamp(Math.round(r), 0, 255),
      g: clamp(Math.round(g), 0, 255),
      b: clamp(Math.round(b), 0, 255),
      a: clamp(alpha, 0, 1),
    };
  }

  // color(srgb 0 0.4 1 / 0.5) — what Chrome returns on wide-gamut displays.
  const srgb = value.match(/^color\(\s*srgb\s+([^)]+)\)$/);
  if (srgb) {
    const parts = srgb[1].split(/[\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part) =>
      part.endsWith('%') ? parseFloat(part) / 100 : parseFloat(part);
    const [r, g, b] = parts.slice(0, 3).map(channel);
    const alpha = parts[3] === undefined ? 1 : parseAlpha(parts[3]);
    if ([r, g, b, alpha].some(Number.isNaN)) return null;
    return {
      r: clamp(Math.round(r * 255), 0, 255),
      g: clamp(Math.round(g * 255), 0, 255),
      b: clamp(Math.round(b * 255), 0, 255),
      a: clamp(alpha, 0, 1),
    };
  }

  return null;
}

function parseAlpha(part) {
  return part.endsWith('%') ? parseFloat(part) / 100 : parseFloat(part);
}

/** `#rrggbb`, uppercase — the form tokens are written in. */
export function toHex({ r, g, b }) {
  const byte = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`.toUpperCase();
}

/** Round-trips a parsed colour to the shortest string that still carries alpha. */
export function formatColor(color) {
  if (!color) return null;
  if (color.a >= 1) return toHex(color);
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${Number(color.a.toFixed(3))})`;
}

const D65 = { x: 95.047, y: 100, z: 108.883 };

function toLab({ r, g, b }) {
  const linear = (channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];

  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) * 100;
  const y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175) * 100;
  const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) * 100;

  const f = (value) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
  const [fx, fy, fz] = [f(x / D65.x), f(y / D65.y), f(z / D65.z)];

  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * CIEDE2000 difference between two RGB colours. Roughly: under 1 is invisible,
 * under 2.3 is the "just noticeable difference", over 10 reads as a different
 * colour. The audit uses those bands to decide whether a value is a token
 * rendered slightly differently or a genuinely off-system colour.
 */
export function deltaE(rgb1, rgb2) {
  const a = toLab(rgb1);
  const b = toLab(rgb2);

  const kL = 1;
  const kC = 1;
  const kH = 1;

  const c1 = Math.hypot(a.a, a.b);
  const c2 = Math.hypot(b.a, b.b);
  const cBar = (c1 + c2) / 2;

  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1Prime = a.a * (1 + g);
  const a2Prime = b.a * (1 + g);

  const c1Prime = Math.hypot(a1Prime, a.b);
  const c2Prime = Math.hypot(a2Prime, b.b);

  const hue = (aPrime, bValue) => {
    if (aPrime === 0 && bValue === 0) return 0;
    const degrees = (Math.atan2(bValue, aPrime) * 180) / Math.PI;
    return degrees >= 0 ? degrees : degrees + 360;
  };
  const h1Prime = hue(a1Prime, a.b);
  const h2Prime = hue(a2Prime, b.b);

  const deltaL = b.l - a.l;
  const deltaC = c2Prime - c1Prime;

  let deltaHPrime;
  if (c1Prime * c2Prime === 0) {
    deltaHPrime = 0;
  } else if (Math.abs(h2Prime - h1Prime) <= 180) {
    deltaHPrime = h2Prime - h1Prime;
  } else {
    deltaHPrime = h2Prime - h1Prime > 180 ? h2Prime - h1Prime - 360 : h2Prime - h1Prime + 360;
  }
  const deltaH =
    2 * Math.sqrt(c1Prime * c2Prime) * Math.sin((deltaHPrime * Math.PI) / 360);

  const lBar = (a.l + b.l) / 2;
  const cBarPrime = (c1Prime + c2Prime) / 2;

  let hBarPrime;
  if (c1Prime * c2Prime === 0) {
    hBarPrime = h1Prime + h2Prime;
  } else if (Math.abs(h1Prime - h2Prime) <= 180) {
    hBarPrime = (h1Prime + h2Prime) / 2;
  } else {
    hBarPrime =
      h1Prime + h2Prime < 360 ? (h1Prime + h2Prime + 360) / 2 : (h1Prime + h2Prime - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos(((hBarPrime - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hBarPrime * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hBarPrime + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hBarPrime - 63) * Math.PI) / 180);

  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sC = 1 + 0.045 * cBarPrime;
  const sH = 1 + 0.015 * cBarPrime * t;

  const deltaTheta = 30 * Math.exp(-(((hBarPrime - 275) / 25) ** 2));
  const rC = 2 * Math.sqrt(cBarPrime ** 7 / (cBarPrime ** 7 + 25 ** 7));
  const rT = -rC * Math.sin((2 * deltaTheta * Math.PI) / 180);

  return Math.sqrt(
    (deltaL / (kL * sL)) ** 2 +
      (deltaC / (kC * sC)) ** 2 +
      (deltaH / (kH * sH)) ** 2 +
      rT * (deltaC / (kC * sC)) * (deltaH / (kH * sH)),
  );
}

/** WCAG relative luminance, for the contrast checks in the audit. */
export function luminance({ r, g, b }) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(foreground, background) {
  const l1 = luminance(foreground);
  const l2 = luminance(background);
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Composites a translucent colour over an opaque backdrop. */
export function flatten(color, backdrop = { r: 255, g: 255, b: 255, a: 1 }) {
  if (!color) return null;
  if (color.a >= 1) return { ...color, a: 1 };
  const mix = (channel) => color[channel] * color.a + backdrop[channel] * (1 - color.a);
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: 1 };
}
