import path from 'node:path';
import { newManifest, saveManifest, writeJson } from '../../src/pack/io';
import { PackPaths, UNIT_FILES } from '../../src/pack/paths';
import type {
  AnimationsFile,
  AssetIndex,
  Manifest,
  PageMeta,
  SectionsFile,
  StepsFile,
  StylesFile,
  TextFile,
} from '../../src/pack/schemas';

const AT = '2026-09-18T00:00:00.000Z';
export const SYNTH_URL = 'http://127.0.0.1:1/';
export const HERO = 'body>main:nth-of-type(1)>section:nth-of-type(1)';

/**
 * a pack small enough to read in a test: one captured page with a header and a hero, a state
 * on it, a captured flow step. every unit file is present and valid; no pngs (nothing here is
 * verified, only briefed and scaffolded).
 */
export async function synthPack(root: string): Promise<Manifest> {
  const pack = new PackPaths(root);
  const m = newManifest({ host: '127.0.0.1', sourceUrl: SYNTH_URL });
  const base = { rounds: 0, updatedAt: AT };
  m.units['page:index#s01-header'] = {
    kind: 'section',
    status: 'captured',
    dependsOn: [],
    ...base,
  };
  m.units['page:index#s02-hero-hello'] = {
    kind: 'section',
    status: 'captured',
    dependsOn: [],
    ...base,
  };
  m.units['page:index'] = {
    kind: 'page',
    status: 'captured',
    url: SYNTH_URL,
    dependsOn: ['page:index#s01-header', 'page:index#s02-hero-hello'],
    ...base,
  };
  const click = {
    kind: 'click' as const,
    target: { role: { role: 'button', name: 'Open' }, text: 'Open', css: '#open' },
    value: null,
    input: null,
    scroll: null,
  };
  m.units['state:index/modal-open'] = {
    kind: 'state',
    status: 'captured',
    url: SYNTH_URL,
    dependsOn: ['page:index'],
    actions: [click],
    ...base,
  };
  m.units['flow:signup/step-01-click-open'] = {
    kind: 'flowStep',
    status: 'captured',
    url: SYNTH_URL,
    dependsOn: [],
    ...base,
  };
  m.flows['signup'] = { steps: ['flow:signup/step-01-click-open'], inputs: {} };
  await saveManifest(root, m);
  const steps: StepsFile = {
    flow: 'signup',
    start: SYNTH_URL,
    recordedAt: AT,
    steps: [{ ...click, n: 1, url: SYNTH_URL, at: AT }],
  };
  await writeJson(pack.stepsFile('signup'), steps);

  const sections: SectionsFile = [
    {
      id: 's01-header',
      order: 1,
      role: 'header',
      heading: '',
      selector: 'header',
      path: 'body>header:nth-of-type(1)',
      ref: 'r1',
      dataSection: null,
      bbox: {
        mobile: { x: 0, y: 0, width: 390, height: 56 },
        desktop: { x: 0, y: 0, width: 1440, height: 72 },
      },
      items: [],
      buttons: [],
      imageCount: 0,
      svgCount: 1,
    },
    {
      id: 's02-hero-hello',
      order: 2,
      role: 'hero',
      heading: 'Hello',
      selector: 'main > section:nth-of-type(1)',
      path: HERO,
      ref: 'r2',
      dataSection: null,
      bbox: {
        mobile: { x: 0, y: 56, width: 390, height: 500 },
        desktop: { x: 0, y: 72, width: 1440, height: 640 },
      },
      items: [
        {
          title: 'Fast',
          description: 'Very fast.',
          path: `${HERO}>ul:nth-of-type(1)>li:nth-of-type(1)`,
        },
      ],
      buttons: ['Start free'],
      imageCount: 1,
      svgCount: 0,
    },
  ];
  const el = (ref: string, tag: string, styles: Record<string, string>) => ({
    ref,
    dataRef: null,
    tag,
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    styles,
  });
  const styles: StylesFile = {
    mobile: {
      'body>header:nth-of-type(1)': el('r1', 'header', { 'background-color': 'rgb(17, 24, 39)' }),
      [HERO]: el('r2', 'section', { 'padding-top': '48px' }),
      [`${HERO}>h1:nth-of-type(1)`]: el('r3', 'h1', {
        'font-size': '32px',
        color: 'rgb(31, 41, 55)',
      }),
    },
    desktop: {
      'body>header:nth-of-type(1)': el('r1', 'header', { 'background-color': 'rgb(17, 24, 39)' }),
      [HERO]: el('r2', 'section', { 'padding-top': '64px' }),
      [`${HERO}>h1:nth-of-type(1)`]: el('r3', 'h1', {
        'font-size': '48px',
        color: 'rgb(31, 41, 55)',
      }),
      [`${HERO}>a:nth-of-type(1)`]: el('r4', 'a', { 'background-color': 'rgb(37, 99, 235)' }),
    },
  };
  const animations: AnimationsFile = {
    keyframes: {
      fadeIn: {
        from: 'cssom',
        stops: [
          { offset: '0%', declarations: { opacity: '0' } },
          { offset: '100%', declarations: { opacity: '1' } },
        ],
      },
    },
    elements: {
      mobile: {},
      desktop: {
        [`${HERO}>h1:nth-of-type(1)`]: {
          ref: 'r3',
          dataRef: null,
          animation: {
            'animation-name': 'fadeIn',
            'animation-duration': '0.3s',
            'animation-timing-function': 'ease-out',
            'animation-delay': '0s',
            'animation-iteration-count': '1',
            'animation-direction': 'normal',
            'animation-fill-mode': 'forwards',
            'animation-play-state': 'running',
          },
          transition: null,
        },
      },
    },
    observed: { mobile: [], desktop: [] },
    unreadableStylesheets: [],
  };
  const meta: PageMeta = {
    url: SYNTH_URL,
    finalUrl: SYNTH_URL,
    title: 'Synth',
    reachedBy: 'goto',
    capturedAt: AT,
    masks: { mobile: [], desktop: [{ x: 10, y: 300, width: 40, height: 20 }] },
    fonts: [
      {
        family: 'Fixture',
        weight: '400',
        style: 'normal',
        status: 'loaded',
        file: 'font-abc-Fixture-Regular.woff2',
        url: `${SYNTH_URL}fonts/Fixture-Regular.woff2`,
      },
      { family: 'Arial', weight: '400', style: 'normal', status: 'loaded', file: null, url: null },
    ],
    colours: ['rgb(31, 41, 55)', 'rgb(37, 99, 235)', 'rgb(17, 24, 39)', 'rgba(0, 0, 0, 0.5)'],
    trackers: [],
    failedAssets: [],
    stylesheetParseErrors: [],
    pageHeight: { mobile: 900, desktop: 1200 },
    motion: { mobile: null, desktop: null },
  };
  const assets: AssetIndex = [
    {
      url: `${SYNTH_URL}fonts/Fixture-Regular.woff2`,
      file: 'font-abc-Fixture-Regular.woff2',
      contentType: 'font/woff2',
      size: 10,
      kind: 'font',
    },
    {
      url: `${SYNTH_URL}hero.png`,
      file: 'image-def-hero.png',
      contentType: 'image/png',
      size: 10,
      kind: 'image',
    },
  ];
  const text: TextFile = [];
  for (const dir of [
    pack.pageDir('index'),
    pack.stateDir('index', 'modal-open'),
    pack.flowStepDir('signup', 'step-01-click-open'),
  ]) {
    await writeJson(path.join(dir, UNIT_FILES.sections), sections);
    await writeJson(path.join(dir, UNIT_FILES.styles), styles);
    await writeJson(path.join(dir, UNIT_FILES.animations), animations);
    await writeJson(path.join(dir, UNIT_FILES.meta), meta);
    await writeJson(path.join(dir, UNIT_FILES.text), text);
    await writeJson(path.join(dir, UNIT_FILES.assetsIndex), assets);
  }
  return m;
}
