import { describe, it, expect } from 'vitest';
import { globToRegExp, recordState, unitActions } from '../../src/capture/explore';

describe('globToRegExp', () => {
  it('treats ? as a literal, not as a regexp quantifier', () => {
    const re = globToRegExp('/a?b/*');
    expect(re.test('/a?b/x')).toBe(true);
    expect(re.test('/axb/x')).toBe(false);
    expect(re.test('/ab/x')).toBe(false);
  });

  it('lets ** cross a slash and keeps * within one segment', () => {
    expect(globToRegExp('/docs/**').test('/docs/guide/intro')).toBe(true);
    expect(globToRegExp('/docs/*').test('/docs/guide')).toBe(true);
    expect(globToRegExp('/docs/*').test('/docs/guide/intro')).toBe(false);
  });

  it('anchors both ends', () => {
    expect(globToRegExp('/docs/*').test('/other/docs/guide')).toBe(false);
  });
});

describe('actions per viewport', () => {
  const click = (name: string) => ({
    kind: 'click' as const,
    target: { role: { role: 'button', name }, text: name, css: `#${name}` },
    value: null,
    input: null,
    scroll: null,
  });
  it('keeps one action list when every pass agrees, and one per viewport when they differ', () => {
    const found = new Map();
    recordState(found, 'desktop', { name: 'menu-open', actions: [click('Menu')] });
    recordState(found, 'mobile', { name: 'menu-open', actions: [click('Menu')] });
    expect(unitActions(found.get('menu-open'))).toEqual({ actions: [click('Menu')] });
    const differ = new Map();
    recordState(differ, 'desktop', { name: 'menu-open', actions: [click('Menu')] });
    recordState(differ, 'mobile', { name: 'menu-open', actions: [click('Burger')] });
    expect(unitActions(differ.get('menu-open'))).toEqual({
      actions: [click('Menu')],
      actionsByViewport: { desktop: [click('Menu')], mobile: [click('Burger')] },
    });
    expect(differ.get('menu-open').reachable).toEqual(['desktop', 'mobile']);
  });
});
