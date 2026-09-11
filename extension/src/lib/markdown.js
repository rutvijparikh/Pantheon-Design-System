/**
 * Minimal markdown renderer for the side panel.
 *
 * The panel runs under the extension CSP with no bundled markdown library, so
 * this handles the subset Claude actually emits: fenced code, headings, lists,
 * block quotes, inline code, emphasis and http(s) links.
 *
 * Safety: the source is HTML-escaped before any markup is added, and links are
 * only emitted for http(s) URLs, so nothing the model writes can inject markup
 * or a `javascript:` href.
 */

const escapeHtml = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Placeholder for a lifted code fence. Escaping leaves it untouched. */
const FENCE = (index) => `@@pantheon-fence-${index}@@`;

/**
 * Minimal markdown renderer.
 *
 * The panel runs under the extension CSP with no bundled markdown library, so
 * this handles the subset Claude actually emits. The input is escaped before
 * any markup is added, so no model output can inject HTML.
 */
export function renderMarkdown(source) {
  const fences = [];
  const text = escapeHtml(source).replace(
    /```[\w-]*\n?([\s\S]*?)(?:```|$)/g,
    (_match, code) => {
      fences.push(`<pre><code>${code.replace(/\n+$/, '')}</code></pre>`);
      return FENCE(fences.length - 1);
    },
  );

  const inline = (value) =>
    value
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );

  const html = [];
  let list = null;

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of text.split('\n')) {
    const placeholder = line.match(/^@@pantheon-fence-(\d+)@@$/);
    if (placeholder) {
      closeList();
      html.push(fences[Number(placeholder[1])]);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      if (list !== 'ul') {
        closeList();
        html.push('<ul>');
        list = 'ul';
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      if (list !== 'ol') {
        closeList();
        html.push('<ol>');
        list = 'ol';
      }
      html.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }

  closeList();
  return html.join('');
}
