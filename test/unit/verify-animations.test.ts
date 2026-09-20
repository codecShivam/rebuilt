import { describe, it, expect } from 'vitest';
import {
  compareAnimations,
  normaliseStops,
  normaliseValue,
  serialiseStops,
} from '../../src/verify/animations';
import type { AnimationsFile, ObservedAnimation } from '../../src/pack/schemas';

const BADGE = 'body>main:nth-of-type(1)>section:nth-of-type(1)>span:nth-of-type(1)';
const H1 = 'body>main:nth-of-type(1)>section:nth-of-type(1)>h1:nth-of-type(1)';
const BUTTON = 'body>main:nth-of-type(1)>section:nth-of-type(1)>a:nth-of-type(1)';

const PULSE = [
  { offset: '0%', declarations: { transform: 'scale(1)' } },
  { offset: '50%', declarations: { transform: 'scale(1.08)' } },
  { offset: '100%', declarations: { transform: 'scale(1)' } },
];
const FADE = [
  { offset: '0%', declarations: { opacity: '0', transform: 'translateY(24px)' } },
  { offset: '100%', declarations: { opacity: '1', transform: 'none' } },
];

function file(over: Partial<AnimationsFile> = {}): AnimationsFile {
  return {
    keyframes: {
      pulse: { from: 'cssom', stops: PULSE },
      fadeIn: { from: 'cssom', stops: FADE },
    },
    elements: {
      mobile: {},
      desktop: {
        [BADGE]: {
          ref: 'rbadge',
          dataRef: null,
          animation: {
            'animation-name': 'pulse',
            'animation-duration': '2s',
            'animation-timing-function': 'ease-in-out',
            'animation-delay': '0s',
            'animation-iteration-count': 'infinite',
            'animation-direction': 'normal',
            'animation-fill-mode': 'none',
          },
          transition: null,
        },
        [H1]: {
          ref: 'rh1',
          dataRef: null,
          animation: {
            'animation-name': 'fadeIn',
            'animation-duration': '0.3s',
            'animation-timing-function': 'ease-out',
            'animation-delay': '0s',
            'animation-iteration-count': '1',
            'animation-direction': 'normal',
            'animation-fill-mode': 'forwards',
          },
          transition: null,
        },
        [BUTTON]: {
          ref: 'rbutton',
          dataRef: null,
          animation: null,
          transition: {
            'transition-property': 'background-color',
            'transition-duration': '0.2s',
            'transition-timing-function': 'ease-in-out',
            'transition-delay': '0s',
          },
        },
      },
    },
    observed: { mobile: [], desktop: [] },
    unreadableStylesheets: [],
    ...over,
  };
}

const waapi: ObservedAnimation = {
  id: '3',
  type: 'WebAnimation',
  name: '',
  path: H1,
  ref: 'rh1',
  dataRef: null,
  duration: 500,
  delay: 100,
  iterations: 2,
  easing: 'ease-in',
  keyframeEasings: ['linear', 'linear'],
  phase: 'load',
  startedAt: 40,
};

describe('compareAnimations', () => {
  it('finds nothing when ours matches the source', () => {
    expect(compareAnimations(file(), file(), ['mobile', 'desktop'])).toEqual([]);
  });

  it('fails a missing animation, a changed easing and a missing transition, once each', () => {
    const ours = file();
    ours.elements.desktop[H1]!.animation = null;
    ours.elements.desktop[BADGE]!.animation!['animation-timing-function'] = 'linear';
    ours.elements.desktop[BUTTON]!.transition = null;
    const findings = compareAnimations(file(), ours, ['mobile', 'desktop']);
    expect(findings.map((f) => [f.path, f.property, f.expected, f.actual])).toEqual([
      [BADGE, 'animation-timing-function', 'ease-in-out', 'linear'],
      [H1, 'animation-name', 'fadeIn', 'none'],
      [BUTTON, 'transition-property', 'background-color', 'none'],
    ]);
    expect(findings[0]!.viewport).toBe('desktop');
    expect(findings[0]!.ref).toBe('rbadge');
  });

  it('compares keyframes once per name and viewport, and reports a missing rule', () => {
    const ours = file();
    ours.keyframes['pulse'] = {
      from: 'cssom',
      stops: [
        { offset: '0%', declarations: { transform: 'scale(1)' } },
        { offset: '50%', declarations: { transform: 'scale(1.2)' } },
        { offset: '100%', declarations: { transform: 'scale(1)' } },
      ],
    };
    delete ours.keyframes['fadeIn'];
    // two elements pulse on both sides; the rule is reported once, on the first
    const source = file();
    const other = { ...source.elements.desktop[BADGE]!, ref: 'rother' };
    source.elements.desktop['body>p:nth-of-type(9)'] = other;
    ours.elements.desktop['body>p:nth-of-type(9)'] = other;
    const findings = compareAnimations(source, ours, ['desktop']);
    expect(findings.map((f) => [f.path, f.property])).toEqual([
      [BADGE, 'keyframes:pulse'],
      [H1, 'keyframes:fadeIn'],
    ]);
    expect(findings[0]!.expected).toContain('scale(1.08)');
    expect(findings[0]!.actual).toContain('scale(1.2)');
    expect(findings[1]!.actual).toBe('(missing)');
  });

  it('reads a rule parsed from a stylesheet body as equal to the cssom rule it came from', () => {
    const ours = file();
    ours.keyframes['fadeIn'] = {
      from: 'stylesheet',
      stops: [
        { offset: '100%', declarations: { opacity: '1', transform: 'NONE' } },
        { offset: '0%', declarations: { transform: 'translateY( 24px )', opacity: '0' } },
      ],
    };
    ours.keyframes['pulse'] = {
      from: 'stylesheet',
      stops: [
        { offset: '0%', declarations: { transform: 'scale(1)' } },
        { offset: '100%', declarations: { transform: 'scale(1)' } },
        { offset: '50%', declarations: { transform: 'scale(1.08)' } },
      ],
    };
    expect(compareAnimations(file(), ours, ['desktop'])).toEqual([]);
  });

  it('gates an observed waapi animation by presence and timing, matched by ref', () => {
    const source = file({ observed: { mobile: [], desktop: [waapi] } });
    expect(compareAnimations(source, file(), ['desktop']).map((f) => f.property)).toEqual([
      'observed:WebAnimation',
    ]);
    const slower = file({ observed: { mobile: [], desktop: [{ ...waapi, duration: 800 }] } });
    const finding = compareAnimations(source, slower, ['desktop'])[0]!;
    expect(finding.expected).toBe('500ms x2 ease-in +100ms');
    expect(finding.actual).toBe('800ms x2 ease-in +100ms');
    expect(compareAnimations(source, source, ['desktop'])).toEqual([]);
    // a css animation observed on one side only is not a finding: the longhands own it
    const cssOnly = file({
      observed: { mobile: [], desktop: [{ ...waapi, type: 'CSSAnimation', name: 'pulse' }] },
    });
    expect(compareAnimations(cssOnly, file(), ['desktop'])).toEqual([]);
  });

  it('matches an observed animation by data-ref, and reports it missing without one', () => {
    // a rebuild that carries data-ref answers for the source's element wherever it moved the
    // markup to; the computed ref alone would call the animation missing
    const source = file({ observed: { mobile: [], desktop: [waapi] } });
    const moved: ObservedAnimation = {
      ...waapi,
      path: 'body>div:nth-of-type(1)>h1:nth-of-type(1)',
      ref: 'rsomething',
      dataRef: 'rh1',
    };
    const marked = file({ observed: { mobile: [], desktop: [moved] } });
    expect(compareAnimations(source, marked, ['desktop'])).toEqual([]);
    const unmarked = file({ observed: { mobile: [], desktop: [{ ...moved, dataRef: null }] } });
    const findings = compareAnimations(source, unmarked, ['desktop']);
    expect(findings.map((f) => [f.property, f.actual])).toEqual([
      ['observed:WebAnimation', '(missing)'],
    ]);
  });

  it('honours the section restriction and matches ours by data-ref', () => {
    const ours = file();
    ours.elements.desktop['body>div:nth-of-type(1)>span:nth-of-type(1)'] = {
      ...ours.elements.desktop[BADGE]!,
      ref: 'rsomething',
      dataRef: 'rbadge',
      animation: { ...ours.elements.desktop[BADGE]!.animation!, 'animation-duration': '3s' },
    };
    delete ours.elements.desktop[BADGE];
    const all = compareAnimations(file(), ours, ['desktop']);
    expect(all.map((f) => f.property)).toEqual(['animation-duration']);
    const hero = 'body>main:nth-of-type(1)>section:nth-of-type(1)';
    expect(
      compareAnimations(file(), ours, ['desktop'], (p) => p.startsWith(`${hero}>`)),
    ).toHaveLength(1);
    expect(
      compareAnimations(file(), ours, ['desktop'], (p) => p.startsWith('body>footer')),
    ).toEqual([]);
  });
});

describe('normalisation', () => {
  it('spells values the way the cssom does where a parser cannot know better', () => {
    expect(normaliseValue('#FFF')).toBe('rgb(255, 255, 255)');
    expect(normaliseValue('#2563eb')).toBe('rgb(37, 99, 235)');
    expect(normaliseValue('translateY( 24px )')).toBe('translatey(24px)');
    expect(normaliseValue('scale(1.08) ,  rotate(1deg)')).toBe('scale(1.08), rotate(1deg)');
  });
  it('sorts and merges stops and serialises them for a finding', () => {
    const stops = normaliseStops([
      { offset: '100%', declarations: { opacity: '1' } },
      { offset: '0%', declarations: { opacity: '0' } },
      { offset: '0%', declarations: { transform: 'none' } },
    ]);
    expect(stops).toEqual([
      { offset: '0%', declarations: { opacity: '0', transform: 'none' } },
      { offset: '100%', declarations: { opacity: '1' } },
    ]);
    expect(serialiseStops(stops)).toBe('0% { opacity: 0; transform: none } 100% { opacity: 1 }');
  });
});
