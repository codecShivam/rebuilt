/**
 * in-page extractor. passed to page.evaluate, so it must not reference anything
 * outside its own body. keep it that way: no imports, no module-level helpers.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ExtractOptions {
  styleProps: string[];
  minSectionHeight: number;
  /** a dynamic hint larger than this many viewports is passed over (MASK_HINT_MAX_VIEWPORTS) */
  hintMaxViewports: number;
}
export interface ExtractedElement {
  path: string;
  ref: string;
  dataRef: string | null;
  tag: string;
  bbox: Rect;
  styles: Record<string, string>;
}
export interface ExtractedSection {
  order: number;
  role: string;
  heading: string;
  selector: string;
  path: string;
  ref: string;
  dataSection: string | null;
  bbox: Rect;
  items: { title: string; description: string; path: string }[];
  buttons: string[];
  imageCount: number;
  svgCount: number;
}
export interface ExtractResult {
  title: string;
  url: string;
  pageHeight: number;
  text: { tag: string; text: string; y: number; path: string }[];
  sections: ExtractedSection[];
  elements: ExtractedElement[];
  fonts: { family: string; weight: string; style: string; status: string }[];
  colours: string[];
  links: string[];
  dynamicHints: Rect[];
  trackers: string[];
  dom: string;
}

export const STYLE_PROPS: string[] = [
  'display',
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'z-index',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'gap',
  'row-gap',
  'column-gap',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'grid-template-columns',
  'grid-template-rows',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-align',
  'text-decoration-line',
  'white-space',
  'color',
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'box-shadow',
  'opacity',
  'overflow-x',
  'overflow-y',
  'transform',
  'object-fit',
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
  'animation-name',
  'animation-duration',
  'animation-timing-function',
  'animation-delay',
  'animation-iteration-count',
  'animation-direction',
  'animation-fill-mode',
];

export function extractPage(opts: ExtractOptions): ExtractResult {
  // heuristic thresholds, named so a reader sees what each number means
  const ITEM_TITLE_MAX = 120; // an item whose title is longer than this is a paragraph, not a card
  const TEXT_BLOCK_MAX = 400; // longer than this is body copy, not a block worth keying
  const BUTTON_LABEL_MAX = 60; // a button label longer than this is a sentence
  const BUTTON_MIN_PADDING = 8; // an anchor with less horizontal padding than this is a link
  const MAX_WRAPPER_DEPTH = 6; // single-child wrappers the section walk descends through
  const SKIP_TAGS = ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK'];
  const LANDMARK_TAGS = ['HEADER', 'NAV', 'MAIN', 'FOOTER', 'SECTION', 'ARTICLE', 'ASIDE', 'FORM'];
  function fnv1a(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
  function stablePath(el: Element): string {
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
  function rect(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    };
  }
  function visible(el: Element): boolean {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function clean(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim();
  }
  function selectorFor(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList)
      .slice(0, 2)
      .map((c) => `.${CSS.escape(c)}`)
      .join('');
    const parent = el.parentElement;
    if (!parent || parent === document.body) return `${tag}${cls}`;
    const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(el) + 1})` : '';
    return `${selectorFor(parent)}>${tag}${cls}${nth}`;
  }
  function roleFor(el: Element, heading: string): string {
    const tag = el.tagName.toLowerCase();
    if (tag === 'header' || el.getAttribute('role') === 'banner') return 'header';
    if (tag === 'footer' || el.getAttribute('role') === 'contentinfo') return 'footer';
    if (tag === 'nav') return 'nav';
    const cls = (
      el.className && typeof el.className === 'string' ? el.className : ''
    ).toLowerCase();
    const id = (el.id || '').toLowerCase();
    const hint = `${cls} ${id}`;
    const h = heading.toLowerCase();
    const has = (re: RegExp) => re.test(hint) || re.test(h);
    if (has(/hero|masthead|jumbotron/)) return 'hero';
    if (has(/pricing|plans?\b/)) return 'pricing';
    if (has(/testimonial|review|quote/)) return 'testimonials';
    if (has(/faq|question/)) return 'faq';
    if (has(/feature|benefit|everything/)) return 'features';
    if (has(/cta|call-to-action|ready|get started|start now/)) return 'cta';
    if (el.querySelector('form')) return 'form';
    if (el.querySelector('h1')) return 'hero';
    return 'section';
  }
  function headingOf(el: Element): string {
    const h = el.querySelector('h1,h2,h3');
    return clean(h?.textContent);
  }
  function itemsOf(section: Element): { title: string; description: string; path: string }[] {
    const out: { title: string; description: string; path: string }[] = [];
    const candidates = Array.from(
      section.querySelectorAll('li, article, details, [class*="card"], [class*="item"]'),
    );
    candidates.forEach((c) => {
      if (c.closest('nav')) return;
      // a candidate that contains another candidate is a container (e.g. a `cards`
      // wrapper around `card` children), not an item itself; keep only the innermost
      // candidate in each containment chain.
      if (candidates.some((d) => d !== c && c.contains(d))) return;
      const title = clean(c.querySelector('h1,h2,h3,h4,h5,h6,summary,strong')?.textContent);
      const desc = clean(c.querySelector('p')?.textContent);
      if (!title && !desc) return;
      if (title.length > ITEM_TITLE_MAX) return;
      out.push({ title, description: desc, path: stablePath(c) });
    });
    return out;
  }
  function buttonsOf(section: Element): string[] {
    const labels: string[] = [];
    section.querySelectorAll('a,button,[role="button"],input[type="submit"]').forEach((b) => {
      const label = clean(
        (b as HTMLElement).innerText || b.getAttribute('value') || b.getAttribute('aria-label'),
      );
      if (!label || label.length > BUTTON_LABEL_MAX) return;
      const cs = getComputedStyle(b);
      const looksLikeButton =
        b.tagName === 'BUTTON' ||
        b.getAttribute('role') === 'button' ||
        (b.tagName === 'A' &&
          (cs.display.includes('inline-block') ||
            cs.display === 'block' ||
            cs.display.includes('flex')) &&
          parseFloat(cs.paddingLeft) >= BUTTON_MIN_PADDING);
      if (looksLikeButton && !labels.includes(label)) labels.push(label);
    });
    return labels;
  }

  // sections: landmarks plus tall direct children of main (or body). an app shell wraps
  // the whole page in single-child divs (`<div id="root"><div class="app">`), so the walk
  // descends through those before it looks at children. it stops at a wrapper that is
  // itself a landmark or a section: their children are content, not sections.
  function contentRoot(): Element {
    let el: Element = document.querySelector('main') ?? document.body;
    for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth++) {
      const kids = Array.from(el.children).filter((c) => !SKIP_TAGS.includes(c.tagName));
      const only = kids.length === 1 ? kids[0]! : null;
      if (!only || LANDMARK_TAGS.includes(only.tagName)) break;
      el = only;
    }
    return el;
  }
  const container = contentRoot();
  const candidates: Element[] = [];
  const header = document.querySelector('body > header, header');
  if (header && visible(header)) candidates.push(header);
  Array.from(container.children).forEach((c) => {
    if (c === header) return;
    if (SKIP_TAGS.includes(c.tagName)) return;
    if (!visible(c)) return;
    if (c.getBoundingClientRect().height < opts.minSectionHeight) return;
    if (c.tagName === 'FOOTER') return;
    candidates.push(c);
  });
  const footer = document.querySelector('body > footer, footer');
  if (footer && visible(footer) && !candidates.includes(footer)) candidates.push(footer);

  const sections: ExtractedSection[] = candidates.map((el, i) => {
    const heading = headingOf(el);
    const path = stablePath(el);
    return {
      order: i + 1,
      role: roleFor(el, heading),
      heading,
      selector: selectorFor(el),
      path,
      ref: `r${fnv1a(path)}`,
      dataSection: el.getAttribute('data-section'),
      bbox: rect(el),
      items: itemsOf(el),
      buttons: buttonsOf(el),
      imageCount: el.querySelectorAll('img, picture, [style*="background-image"]').length,
      svgCount: el.querySelectorAll('svg').length,
    };
  });

  // text blocks in dom order
  const text: ExtractResult['text'] = [];
  const seen = new Set<string>();
  document
    .querySelectorAll(
      'h1,h2,h3,h4,h5,h6,p,li,button,a,span,summary,figcaption,label,td,th,blockquote',
    )
    .forEach((el) => {
      if (el.querySelector('h1,h2,h3,h4,h5,h6,p,li')) return;
      if (!visible(el)) return;
      const t = clean((el as HTMLElement).innerText);
      if (!t || t.length > TEXT_BLOCK_MAX) return;
      const key = `${el.tagName}|${t}`;
      if (seen.has(key)) return;
      seen.add(key);
      text.push({
        tag: el.tagName.toLowerCase(),
        text: t,
        y: Math.round(rect(el).y),
        path: stablePath(el),
      });
    });

  // computed styles for every visible element
  const elements: ExtractedElement[] = [];
  const colours = new Set<string>();
  document.body.querySelectorAll('*').forEach((el) => {
    if (
      el.tagName === 'SCRIPT' ||
      el.tagName === 'STYLE' ||
      el.tagName === 'LINK' ||
      el.tagName === 'META'
    )
      return;
    if (!visible(el)) return;
    const cs = getComputedStyle(el);
    const styles: Record<string, string> = {};
    for (const prop of opts.styleProps) styles[prop] = cs.getPropertyValue(prop);
    const path = stablePath(el);
    colours.add(styles['color'] ?? '');
    colours.add(styles['background-color'] ?? '');
    elements.push({
      path,
      ref: `r${fnv1a(path)}`,
      dataRef: el.getAttribute('data-ref'),
      tag: el.tagName.toLowerCase(),
      bbox: rect(el),
      styles,
    });
  });

  const fonts: ExtractResult['fonts'] = [];
  document.fonts.forEach((f) =>
    fonts.push({ family: f.family, weight: f.weight, style: f.style, status: f.status }),
  );

  const links: string[] = [];
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = (a as HTMLAnchorElement).href;
    if (/^https?:/.test(href) && !links.includes(href)) links.push(href);
  });

  const dynamicHints: Rect[] = [];
  const hinted = new Set<Element>();
  // a hint larger than the bound would mask the page: a `.carousel` class on a wrapper, a
  // canvas the size of the document. the same idea as the mask owner ratio in masks.ts
  const maxHintArea = opts.hintMaxViewports * window.innerWidth * window.innerHeight;
  function hint(el: Element): void {
    if (hinted.has(el) || !visible(el)) return;
    const r = rect(el);
    if (r.width * r.height > maxHintArea) return;
    hinted.add(el);
    dynamicHints.push(r);
  }
  document.querySelectorAll('video, canvas, iframe').forEach((el) => {
    // a same-origin iframe is content the rebuild reproduces; only an opaque one is masked
    if (el.tagName === 'IFRAME' && (el as HTMLIFrameElement).contentDocument) return;
    hint(el);
  });
  // a carousel advances on a timer of its own, often slower than the rest shots span, so it
  // is masked for what it is rather than for having been caught moving
  document
    .querySelectorAll(
      '[aria-roledescription="carousel"], [data-carousel], .swiper, .slick-slider, .carousel',
    )
    .forEach((el) => hint(el));

  const trackers: string[] = [];
  document.querySelectorAll('script[src]').forEach((s) => {
    const src = (s as HTMLScriptElement).src;
    if (
      /googletagmanager|google-analytics|gtag|facebook\.net|fbevents|hotjar|segment|posthog|intercom|hubspot|tiktok|clarity\.ms|mixpanel/i.test(
        src,
      )
    )
      trackers.push(src);
  });

  // dom snapshot: a clone of the document with script/noscript stripped
  const domClone = document.documentElement.cloneNode(true) as HTMLElement;
  domClone.querySelectorAll('script, noscript').forEach((el) => el.remove());
  const dom = '<!doctype html>\n' + domClone.outerHTML;

  return {
    title: document.title,
    url: location.href,
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    text,
    sections,
    elements,
    fonts,
    colours: Array.from(colours).filter((c) => c && c !== 'rgba(0, 0, 0, 0)'),
    links,
    dynamicHints,
    trackers,
    dom,
  };
}
