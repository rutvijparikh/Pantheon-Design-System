/**
 * Page-side collector.
 *
 * Two jobs, both of which need the live DOM: let the user point at an element,
 * and tally which style values the page actually uses. It reports raw values and
 * counts only — deciding whether a value is on-token happens in the extension,
 * against the token index.
 *
 * Injected on demand, so it guards against being injected twice.
 */
(() => {
  if (window.__pantheonCopilotLoaded) return;
  window.__pantheonCopilotLoaded = true;

  const MSG = {
    COLLECT_PAGE: 'collect-page',
    PICK_ELEMENT: 'pick-element',
    ABORT_PICK: 'abort-pick',
    ELEMENT_PICKED: 'element-picked',
    PICK_ABORTED: 'pick-aborted',
  };

  /** Cap the walk so a pathological page cannot hang the tab. */
  const MAX_ELEMENTS = 4000;
  const MAX_EXAMPLES = 3;
  const OVERLAY_ID = 'pantheon-copilot-overlay';
  const LABEL_ID = 'pantheon-copilot-label';

  const TRANSPARENT = /^(rgba\(0,\s*0,\s*0,\s*0\)|transparent)$/;

  // ---------------------------------------------------------------- selectors

  /**
   * A short selector that a developer can paste into devtools. Prefers an id,
   * falls back to tag plus the first class, and adds `:nth-of-type` only when
   * the path would otherwise be ambiguous among siblings.
   */
  function selectorFor(element) {
    if (!(element instanceof Element)) return '';
    const parts = [];
    let node = element;

    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      if (node.id && document.querySelectorAll(`#${cssEscape(node.id)}`).length === 1) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }

      let part = node.localName;
      const className = [...node.classList]
        .filter((name) => !name.startsWith('pantheon-copilot'))
        .find((name) => /^[a-zA-Z_-][\w-]*$/.test(name));
      if (className) part += `.${className}`;

      const siblings = node.parentElement
        ? [...node.parentElement.children].filter((child) => child.localName === node.localName)
        : [];
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }

      parts.unshift(part);
      node = node.parentElement;
      if (node === document.body || node === document.documentElement) break;
    }

    return parts.join(' > ');
  }

  const cssEscape = (value) =>
    window.CSS?.escape ? CSS.escape(value) : value.replace(/([^\w-])/g, '\\$1');

  // ------------------------------------------------------------- ua baseline

  /**
   * Box values the browser's own stylesheet supplies are not design decisions:
   * every `<h2>` carries a margin and every `<ul>` a 40px inset. Reporting them
   * buries the values the page actually chose, so each one is compared against a
   * baseline measured from a bare element of the same tag.
   *
   * The probe element is given the real element's font size, because UA margins
   * are em-based — an `<h2>` at 24px and one at 32px have different defaults.
   */
  const uaCache = new Map();
  let probe = null;

  const BOX_SIDES = ['Top', 'Right', 'Bottom', 'Left'];

  function uaBaseline(tagName, fontSize) {
    const key = `${tagName}|${fontSize}`;
    const cached = uaCache.get(key);
    if (cached) return cached;

    const measured = measureBaseline(tagName, fontSize);
    uaCache.set(key, measured);
    return measured;
  }

  /** An about:blank iframe carries the UA stylesheet and none of the page's. */
  function measureBaseline(tagName, fontSize) {
    const empty = {};
    try {
      if (!probe) {
        probe = document.createElement('iframe');
        probe.setAttribute('aria-hidden', 'true');
        probe.setAttribute('tabindex', '-1');
        probe.style.cssText =
          'position:absolute;left:-9999px;top:0;width:1px;height:1px;border:0;visibility:hidden';
        document.documentElement.append(probe);
      }
      const doc = probe.contentDocument;
      if (!doc?.body) return empty;

      const element = doc.createElement(tagName);
      element.style.fontSize = fontSize;
      doc.body.append(element);
      const style = doc.defaultView.getComputedStyle(element);

      const baseline = {};
      for (const side of BOX_SIDES) {
        baseline[`margin${side}`] = px(style[`margin${side}`]) ?? 0;
        baseline[`padding${side}`] = px(style[`padding${side}`]) ?? 0;
      }
      element.remove();
      return baseline;
    } catch {
      // A restrictive CSP can block the probe frame; fall back to auditing
      // everything rather than silently skipping real findings.
      return empty;
    }
  }

  /** True when the page, not the browser, chose this value. */
  function isAuthored(value, baseline, key) {
    if (!(key in baseline)) return true;
    return Math.abs(value - baseline[key]) > 0.5;
  }

  // ------------------------------------------------------------- style probes

  /** True when the element renders text of its own, rather than only children. */
  function hasOwnText(element) {
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return true;
    }
    return false;
  }

  /**
   * The colour actually behind an element: the nearest ancestor with a
   * non-transparent background, or the canvas white if there is none.
   */
  function effectiveBackground(element) {
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const background = getComputedStyle(node).backgroundColor;
      if (background && !TRANSPARENT.test(background.replace(/\s+/g, ' '))) return background;
      node = node.parentElement;
    }
    return 'rgb(255, 255, 255)';
  }

  const px = (value) => {
    const amount = parseFloat(value);
    return Number.isNaN(amount) ? null : amount;
  };

  /** Elements too small, hidden or structural to carry design intent. */
  function isAuditable(element, style) {
    if (element.closest(`#${OVERLAY_ID}, #${LABEL_ID}`)) return false;
    if (element === probe) return false;
    if (element.ownerSVGElement || element.localName === 'svg') return false;
    if (['script', 'style', 'meta', 'link', 'title', 'head', 'noscript'].includes(element.localName)) {
      return false;
    }
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // -------------------------------------------------------- element capture

  /** Everything the audit needs about one element. */
  function sampleElement(element) {
    const style = getComputedStyle(element);
    const background = effectiveBackground(element);

    const colors = {};
    if (hasOwnText(element)) colors.color = style.color;
    if (!TRANSPARENT.test(style.backgroundColor.replace(/\s+/g, ' '))) {
      colors['background-color'] = style.backgroundColor;
    }
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (px(style[`border${side}Width`]) > 0) {
        colors[`border-${side.toLowerCase()}-color`] = style[`border${side}Color`];
      }
    }

    const baseline = uaBaseline(element.localName, style.fontSize);
    const spacing = {};
    for (const side of BOX_SIDES) {
      const key = side.toLowerCase();
      const padding = px(style[`padding${side}`]);
      if (padding > 0 && isAuthored(padding, baseline, `padding${side}`)) {
        spacing[`padding-${key}`] = `${padding}px`;
      }
      const margin = px(style[`margin${side}`]);
      if (margin > 0 && isAuthored(margin, baseline, `margin${side}`)) {
        spacing[`margin-${key}`] = `${margin}px`;
      }
    }
    for (const property of ['gap', 'rowGap', 'columnGap']) {
      const gap = px(style[property]);
      if (gap > 0) spacing[kebab(property)] = `${gap}px`;
    }

    const radii = {};
    for (const corner of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']) {
      const radius = px(style[`border${corner}Radius`]);
      if (radius > 0) radii[`border-${kebab(corner)}-radius`] = `${radius}px`;
    }

    const rect = element.getBoundingClientRect();
    return {
      selector: selectorFor(element),
      tag: element.tagName,
      text: (element.textContent ?? '').trim().slice(0, 200),
      rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
      colors,
      spacing,
      radii,
      typography: {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
      },
      boxShadow: style.boxShadow === 'none' ? null : style.boxShadow,
      contrast: hasOwnText(element)
        ? {
            foreground: style.color,
            background,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
          }
        : null,
    };
  }

  const kebab = (value) => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

  // ------------------------------------------------------------- page tally

  /** Accumulates `value → {count, properties, examples}` for one style family. */
  function tallyFactory() {
    const entries = new Map();
    return {
      add(value, property, selector) {
        if (value === null || value === undefined || value === '') return;
        const key = String(value);
        let entry = entries.get(key);
        if (!entry) {
          entry = { value, count: 0, properties: new Set(), examples: [] };
          entries.set(key, entry);
        }
        entry.count += 1;
        if (property) entry.properties.add(property);
        if (entry.examples.length < MAX_EXAMPLES && selector && !entry.examples.includes(selector)) {
          entry.examples.push(selector);
        }
      },
      list() {
        return [...entries.values()]
          .sort((a, b) => b.count - a.count)
          .map((entry) => ({
            value: entry.value,
            count: entry.count,
            properties: [...entry.properties],
            examples: entry.examples,
          }));
      },
    };
  }

  /**
   * Walk the page and tally every design value in use. Returns counts, not
   * per-element records, so the payload stays small on large pages.
   */
  function collectPage() {
    const colors = tallyFactory();
    const spacing = tallyFactory();
    const radii = tallyFactory();
    const fontFamilies = tallyFactory();
    const fontSizes = tallyFactory();
    const shadows = tallyFactory();
    const contrastPairs = new Map();

    const all = document.body ? document.body.querySelectorAll('*') : [];
    let scanned = 0;

    for (const element of all) {
      if (scanned >= MAX_ELEMENTS) break;
      const style = getComputedStyle(element);
      if (!isAuditable(element, style)) continue;
      scanned += 1;

      const selector = scanned <= 600 ? selectorFor(element) : null;
      const textual = hasOwnText(element);

      if (textual) colors.add(style.color, 'color', selector);
      if (!TRANSPARENT.test(style.backgroundColor.replace(/\s+/g, ' '))) {
        colors.add(style.backgroundColor, 'background-color', selector);
      }
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (px(style[`border${side}Width`]) > 0) {
          colors.add(style[`border${side}Color`], 'border-color', selector);
        }
      }

      const baseline = uaBaseline(element.localName, style.fontSize);
      for (const side of BOX_SIDES) {
        const padding = px(style[`padding${side}`]);
        if (padding > 0 && isAuthored(padding, baseline, `padding${side}`)) {
          spacing.add(padding, `padding-${side.toLowerCase()}`, selector);
        }
        const margin = px(style[`margin${side}`]);
        if (margin > 0 && isAuthored(margin, baseline, `margin${side}`)) {
          spacing.add(margin, `margin-${side.toLowerCase()}`, selector);
        }
      }
      for (const property of ['rowGap', 'columnGap']) {
        const gap = px(style[property]);
        if (gap > 0) spacing.add(gap, kebab(property), selector);
      }

      for (const corner of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']) {
        const radius = px(style[`border${corner}Radius`]);
        if (radius > 0) radii.add(radius, 'border-radius', selector);
      }

      if (textual) {
        fontFamilies.add(style.fontFamily, 'font-family', selector);
        const size = px(style.fontSize);
        if (size) fontSizes.add(size, 'font-size', selector);

        // Resolving the backdrop walks ancestors, so do it once per element.
        const background = effectiveBackground(element);
        const key = `${style.color}|${background}|${style.fontSize}|${style.fontWeight}`;
        let pair = contrastPairs.get(key);
        if (!pair) {
          pair = {
            foreground: style.color,
            background,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            count: 0,
            examples: [],
          };
          contrastPairs.set(key, pair);
        }
        pair.count += 1;
        if (pair.examples.length < MAX_EXAMPLES && selector) pair.examples.push(selector);
      }

      if (style.boxShadow && style.boxShadow !== 'none') {
        shadows.add(style.boxShadow, 'box-shadow', selector);
      }
    }

    // The measuring frame has served its purpose; do not leave it in the page.
    probe?.remove();
    probe = null;
    uaCache.clear();

    return {
      url: location.href,
      title: document.title,
      elementsScanned: scanned,
      truncated: scanned >= MAX_ELEMENTS,
      colors: colors.list(),
      spacing: spacing.list(),
      radii: radii.list(),
      fontFamilies: fontFamilies.list(),
      fontSizes: fontSizes.list(),
      shadows: shadows.list(),
      contrast: [...contrastPairs.values()].sort((a, b) => b.count - a.count),
    };
  }

  // ----------------------------------------------------------- element picker

  let picking = false;
  let overlay = null;
  let label = null;

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    label = document.createElement('div');
    label.id = LABEL_ID;
    document.documentElement.append(overlay, label);
  }

  function moveOverlay(element) {
    ensureOverlay();
    const rect = element.getBoundingClientRect();
    overlay.style.transform = `translate(${rect.left + window.scrollX}px, ${rect.top + window.scrollY}px)`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.display = 'block';

    label.textContent = `${element.localName}${element.id ? `#${element.id}` : ''} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    label.style.display = 'block';
    const above = rect.top > 28;
    label.style.transform = `translate(${rect.left + window.scrollX}px, ${
      (above ? rect.top - 26 : rect.bottom + 4) + window.scrollY
    }px)`;
  }

  function teardown() {
    picking = false;
    document.documentElement.classList.remove('pantheon-copilot-picking');
    overlay?.remove();
    label?.remove();
    overlay = null;
    label = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
  }

  let hovered = null;

  const onMove = (event) => {
    if (!picking) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === hovered) return;
    if (element.id === OVERLAY_ID || element.id === LABEL_ID) return;
    hovered = element;
    moveOverlay(element);
  };

  const onScroll = () => {
    if (picking && hovered) moveOverlay(hovered);
  };

  const onClick = (event) => {
    if (!picking) return;
    event.preventDefault();
    event.stopPropagation();
    const element = hovered ?? document.elementFromPoint(event.clientX, event.clientY);
    teardown();
    if (element) {
      chrome.runtime.sendMessage({ type: MSG.ELEMENT_PICKED, sample: sampleElement(element) });
    }
  };

  const onKey = (event) => {
    if (!picking || event.key !== 'Escape') return;
    event.preventDefault();
    teardown();
    chrome.runtime.sendMessage({ type: MSG.PICK_ABORTED });
  };

  function startPicking() {
    if (picking) return;
    picking = true;
    hovered = null;
    document.documentElement.classList.add('pantheon-copilot-picking');
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    switch (message?.type) {
      case MSG.COLLECT_PAGE:
        respond(collectPage());
        return false;
      case MSG.PICK_ELEMENT:
        startPicking();
        respond({ ok: true });
        return false;
      case MSG.ABORT_PICK:
        teardown();
        respond({ ok: true });
        return false;
      default:
        return false;
    }
  });
})();
