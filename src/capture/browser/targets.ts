/**
 * in-page helpers for naming an element the way a replay can find it again: role and
 * accessible name first, visible text second, a css path last. self-contained: they run
 * inside the page through inPage(fn, [describeTarget]) and are never called from node.
 * keep it that way: no imports, no module-level helpers.
 */
export interface TargetInPage {
  role: { role: string; name: string } | null;
  text: string | null;
  css: string;
}

export function describeTarget(el: Element): TargetInPage {
  const NAME_MAX = 80;
  function clean(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim();
  }
  function cssPath(node: Element): string {
    if (node.id) return `#${CSS.escape(node.id)}`;
    const parts: string[] = [];
    let cur: Element | null = node;
    while (cur && cur !== document.body) {
      const tag = cur.tagName.toLowerCase();
      let n = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) n++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${n})`);
      cur = cur.parentElement;
    }
    return ['body', ...parts].join('>');
  }
  // a role attribute is a list and the page may put anything in it; playwright's role engine
  // takes the first token and only knows plain words, so anything else is no role at all
  function firstRole(value: string): string | null {
    const first = value.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    return /^[a-z]+$/.test(first) ? first : null;
  }
  function implicitRole(node: Element): string | null {
    const explicit = node.getAttribute('role');
    // `role=""` says nothing; playwright's role engine falls back to the implicit role, so do we
    if (explicit !== null && explicit.trim() !== '') return firstRole(explicit);
    const tag = node.tagName;
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A') return node.hasAttribute('href') ? 'link' : null;
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'IMG') return 'img';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'INPUT') {
      const type = (node.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return null;
      return 'textbox';
    }
    // summary has no role in playwright's role engine; text and css carry it
    return null;
  }
  function labelText(node: Element): string {
    const id = node.getAttribute('id');
    if (id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (forLabel) return clean((forLabel as HTMLElement).innerText);
    }
    const wrapping = node.closest('label');
    if (wrapping) {
      const copy = wrapping.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('input,select,textarea').forEach((c) => c.remove());
      return clean(copy.textContent);
    }
    return '';
  }
  function accessibleName(node: Element): string {
    const aria = clean(node.getAttribute('aria-label'));
    if (aria) return aria;
    const by = node.getAttribute('aria-labelledby');
    if (by) {
      const parts = by
        .split(/\s+/)
        .map((ref) => clean(document.getElementById(ref)?.textContent))
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) {
      const label = labelText(node);
      if (label) return label;
      return clean(node.getAttribute('placeholder') || node.getAttribute('title'));
    }
    const text = clean((node as HTMLElement).innerText);
    if (text) return text;
    const img = node.querySelector('img[alt]');
    return clean(img?.getAttribute('alt') || node.getAttribute('title'));
  }
  const role = implicitRole(el);
  const name = accessibleName(el);
  const text = clean((el as HTMLElement).innerText);
  return {
    role: role && name && name.length <= NAME_MAX ? { role, name } : null,
    text: text && text.length <= NAME_MAX ? text : null,
    css: cssPath(el),
  };
}

/** the element a user meant: a span inside a button is the button, a label is its control. */
export function interactiveAncestor(el: Element): Element {
  const hit = el.closest(
    'a,button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"]',
  );
  if (!hit) return el;
  if (hit.tagName === 'LABEL') return (hit as HTMLLabelElement).control ?? hit;
  return hit;
}

/**
 * the stable path styles.json is keyed by: tag and nth-of-type from body, never an id. the
 * same algorithm lives inside extractPage; it is repeated here because in-page functions
 * cannot import. self-contained, passed to inPage(fn, [stablePath]).
 */
export function stablePath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body) {
    const tag = node.tagName.toLowerCase();
    let n = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName === node.tagName) n++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(`${tag}:nth-of-type(${n})`);
    node = node.parentElement;
  }
  return ['body', ...parts].join('>');
}
