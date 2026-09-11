/**
 * Builds the Claude request from an audit.
 *
 * The token set and the reviewer instructions go in `system` behind a cache
 * breakpoint: they are identical on every request in a session, so they should
 * be a cache read rather than fresh input tokens. Everything that changes per
 * question — the page, the findings, the user's message — goes in `messages`
 * after that prefix.
 */
import { flattenTokens, cssVariable, toPixels } from './tokens.js';

const ROLE = `You are Pantheon Copilot, a design-systems engineer reviewing live web pages against the Pantheon Design System.

You are given an automated audit: computed style values scraped from the page, each already compared against the Pantheon token set. Your job is to turn that data into a judgement a front-end engineer can act on.

How to answer:
- Lead with what actually matters. A colour that is 1.4 ΔE off a token on 44 elements is a systemic drift worth fixing; a 2px padding gap on one div usually is not. Say which is which instead of restating the list.
- Reference tokens by their path and CSS variable, e.g. colors.primary / var(--pantheon-colors-primary).
- When you propose a fix, give the CSS. Use var() references to Pantheon tokens, never raw hex or raw px for values that have a token.
- Never invent a token. If the page needs a value the system does not have, say so plainly and call it a gap in the system — that is a useful finding, not a failure.
- Distinguish drift (a value that should be a token and nearly is) from a deliberate exception (a third-party widget, a brand asset, a gradient) and from a real accessibility defect. Contrast failures outrank aesthetic drift.
- Be brief. Prose over bullet soup, no preamble, no summary of what you were asked.`;

/**
 * The cached prefix: role plus the full token set, rendered in both the JSON
 * path form the audit speaks and the CSS variable form a fix has to use.
 */
export function buildSystem(tokenTree) {
  const tokens = flattenTokens(tokenTree);
  const lines = tokens.map((token) => {
    const value =
      token.type === 'number' || token.type === 'dimension'
        ? `${toPixels(token.value)}px`
        : String(token.value);
    const note = token.description ? `  — ${token.description}` : '';
    return `${token.path}  ${value}  ${cssVariable(token.path)}${note}`;
  });

  return [
    {
      type: 'text',
      text: `${ROLE}

# Pantheon tokens (${tokens.length})

path  value  css-variable

${lines.join('\n')}

That list is the entire system. Anything not on it is not a Pantheon token.`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/** Compact, readable rendering of an audit for the model to reason over. */
export function describeAudit(audit, context) {
  const lines = [];

  lines.push(`Page: ${context.title || 'untitled'}`);
  lines.push(`URL: ${context.url}`);

  if (context.mode === 'element') {
    lines.push(`Scope: one element — ${context.selector}`);
    if (context.tag) lines.push(`Element: <${context.tag.toLowerCase()}>`);
    if (context.text) lines.push(`Text: ${truncate(context.text, 160)}`);
  } else {
    lines.push(`Scope: full page — ${audit.elementsScanned} elements scanned`);
  }

  if (audit.coverage) {
    const { overall, color, spacing, radius } = audit.coverage;
    const part = (label, value) => (value === null ? null : `${label} ${value}%`);
    const parts = [part('colour', color), part('spacing', spacing), part('radius', radius)].filter(
      Boolean,
    );
    lines.push(`Token coverage: ${overall ?? '—'}% overall (${parts.join(', ')})`);
  }

  const { errors, warnings, infos } = audit.summary;
  lines.push(
    `Findings: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}, ${plural(infos, 'info')}`,
  );

  if (audit.findings.length === 0) {
    lines.push('', 'No drift detected — every sampled value sits on a token.');
  } else {
    lines.push('', '# Findings', '');
    for (const finding of audit.findings) {
      const scope = finding.count > 1 ? ` [${finding.count} elements]` : '';
      const where = finding.examples?.length
        ? ` (e.g. ${finding.examples.slice(0, 3).join(', ')})`
        : '';
      lines.push(
        `- ${finding.severity.toUpperCase()} ${finding.category} · ${finding.property}${scope}: ${finding.message}${where}`,
      );
    }
  }

  if (audit.typography) {
    const { families, sizes, shadows } = audit.typography;
    const list = (usages, unit = '') =>
      usages
        .slice(0, 8)
        .map((usage) => `${usage.value}${unit} ×${usage.count}`)
        .join(', ');
    if (families?.length) lines.push('', `Font families in use: ${list(families)}`);
    if (sizes?.length) lines.push(`Font sizes in use: ${list(sizes, 'px')}`);
    if (shadows?.length) lines.push(`Shadows in use: ${list(shadows)}`);
    lines.push(
      '(The token file carries no type or shadow ramp — treat these as unmanaged surface area.)',
    );
  }

  return lines.join('\n');
}

const truncate = (value, max) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The first user turn: the audit, then whatever the person asked. */
export function buildOpeningMessage(audit, context, question) {
  const ask =
    question?.trim() ||
    (context.mode === 'element'
      ? 'Review this element against Pantheon. What should change?'
      : 'Review this page against Pantheon. What are the real problems, and what would you fix first?');

  return {
    role: 'user',
    content: `<audit>\n${describeAudit(audit, context)}\n</audit>\n\n${ask}`,
  };
}
