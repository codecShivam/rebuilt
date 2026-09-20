import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { synthPack, HERO, SYNTH_URL } from '../helpers/pack';
import { parseBriefHeader, builderBrief, reviewerBrief } from '../../src/orchestrate/brief';
import {
  allowedFilesFor,
  componentFileFor,
  componentNameFor,
  featureFor,
  isChromeSection,
  routeDirFor,
  routeFileFor,
} from '../../src/orchestrate/layout';
import { readJson, writeJson } from '../../src/pack/io';
import { SectionsFileSchema, type Manifest, type VerifyResult } from '../../src/pack/schemas';

/** how often a brief says the same thing: a path or a finding listed twice is the bug */
const count = (text: string, needle: string) => text.split(needle).length - 1;

let root: string;
let manifest: Manifest;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-brief-'));
  manifest = await synthPack(root);
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('layout', () => {
  it('maps a url path to a route dir, keeping an extension as next serves it', () => {
    expect(routeDirFor('https://x.com/')).toBe('src/app');
    expect(routeDirFor('https://x.com/about.html?x=1#top')).toBe('src/app/about.html');
    expect(routeDirFor('https://x.com/blog/hello-world/')).toBe('src/app/blog/hello-world');
  });

  it('keeps a segment raw when decoding it would throw, split it, or climb out of src/app', () => {
    // a lone % is not an escape: decodeURIComponent throws on it, and a brief must not
    expect(routeDirFor('https://x.com/50%off')).toBe('src/app/50%off');
    // %2F would become a second dir, so two source urls could land on one route dir
    expect(routeDirFor('https://x.com/pricing%2Fplans')).toBe('src/app/pricing%2Fplans');
    // a backslash is a separator too, on the platform a rebuild may be edited on
    expect(routeDirFor('https://x.com/a%5Cb')).toBe('src/app/a%5Cb');
    // the url parser resolves dot segments before we ever see them, so nothing climbs out
    expect(routeDirFor('https://x.com/%2e%2e/etc')).toBe('src/app/etc');
    // a space is decodable and harmless, but no route dir is named with one in it
    expect(routeDirFor('https://x.com/a b')).toBe('src/app/a-b');
  });

  it('turns an id into a component name, prefixing one that would start with a digit', () => {
    expect(componentNameFor('hero')).toBe('Hero');
    expect(componentNameFor('s02-hero-hello')).toBe('S02HeroHello');
    expect(componentNameFor('step-01-click-open')).toBe('Step01ClickOpen');
    expect(componentNameFor('2fa-open')).toBe('U2faOpen');
  });

  it('maps a unit to its feature, component file and route file', () => {
    expect(featureFor('page:index#s02-hero-hello')).toBe('index');
    expect(featureFor('flow:signup/step-01-click-open')).toBe('signup');
    expect(componentFileFor(manifest, 'page:index#s02-hero-hello')).toBe(
      'src/features/index/components/s02-hero-hello.tsx',
    );
    expect(componentFileFor(manifest, 'page:index')).toBe('src/app/page.tsx');
    expect(componentFileFor(manifest, 'state:index/modal-open')).toBe(
      'src/features/index/components',
    );
    expect(componentFileFor(manifest, 'flow:signup/step-01-click-open')).toBe(
      'src/features/signup/components/step-01-click-open.tsx',
    );
    for (const id of [
      'page:index#s02-hero-hello',
      'page:index',
      'state:index/modal-open',
      'flow:signup/step-01-click-open',
    ]) {
      expect(routeFileFor(manifest, id)).toBe('src/app/page.tsx');
    }
  });

  it('lists what a worker may edit: its own files, the route, its feature, the shared dirs; never the theme', () => {
    const files = allowedFilesFor(manifest, 'page:index#s02-hero-hello', '/b');
    expect(files).toEqual([
      '/b/src/features/index/components/s02-hero-hello.tsx',
      '/b/src/app/page.tsx',
      '/b/src/features/index/',
      '/b/src/components/ui/',
      '/b/src/components/errors/',
      '/b/src/assets/',
    ]);
    expect(allowedFilesFor(manifest, 'state:index/modal-open', '/b')[0]).toBe(
      '/b/src/features/index/components/',
    );
    // the theme and the global styles are generated from the pack and shared by every worker:
    // two builders writing one file at once would leave the last writer's, so neither is on
    // any list, and a measurement the theme lacks is an arbitrary value
    for (const id of ['page:index#s02-hero-hello', 'page:index#s01-header', 'page:index']) {
      const list = allowedFilesFor(manifest, id, '/b');
      expect(list, id).not.toContain('/b/tailwind.config.cjs');
      expect(
        list.some((f) => f.includes('/src/styles')),
        id,
      ).toBe(false);
    }
  });

  it('names the shared layouts dir for a chrome section and for nothing else', () => {
    // the no-op negative first: a hero is not chrome, so the dir every page renders is not its
    for (const id of ['page:index#s02-hero-hello', 'page:index', 'state:index/modal-open']) {
      const files = allowedFilesFor(manifest, id, '/b');
      expect(
        files.some((f) => f.includes('layouts')),
        id,
      ).toBe(false);
      // and there is no bare src/components/ to reach the layouts through by prefix
      expect(files, id).not.toContain('/b/src/components/');
      expect(files, id).toContain('/b/src/components/ui/');
    }
    expect(isChromeSection('page:index#s02-hero-hello')).toBe(false);
    expect(isChromeSection('page:index')).toBe(false);
    const chrome = allowedFilesFor(manifest, 'page:index#s01-header', '/b');
    expect(chrome).toContain('/b/src/components/layouts/');
    expect(chrome).not.toContain('/b/src/components/');
    expect(isChromeSection('page:index#s01-header')).toBe(true);
    // the role is the section id's second token, whatever the heading words after it say
    expect(isChromeSection('page:index#s07-footer-talk-to-us-hero')).toBe(true);
    expect(isChromeSection('page:index#s04-nav')).toBe(true);
  });

  it('resolves a relative project, so every allowed entry is still absolute', () => {
    const files = allowedFilesFor(manifest, 'page:index', 'build/site');
    expect(files.every((f) => path.isAbsolute(f))).toBe(true);
    expect(files[0]).toBe(path.resolve('build/site', 'src/app/page.tsx'));
  });

  it('refuses a unit the manifest has no url for', () => {
    expect(() => componentFileFor(manifest, 'page:nope')).toThrow(/has no url in the manifest/);
    expect(() => routeFileFor(manifest, 'page:nope')).toThrow(/page:nope/);
  });
});

describe('builderBrief', () => {
  const input = (
    unitId: string,
    previous: Parameters<typeof builderBrief>[0]['previous'] = null,
  ) => ({
    root,
    manifest,
    unitId,
    round: 1,
    rounds: 6,
    project: '/b',
    target: 'http://127.0.0.1:3000',
    threshold: 0.001,
    shotsDir: '/r/round-1/shots',
    previous,
  });

  it('briefs a section with its paths, boxes, refs, styles, animations, fonts and the rules', async () => {
    const text = await builderBrief(input('page:index#s02-hero-hello'));
    expect(parseBriefHeader(text)).toEqual({
      role: 'builder',
      unit: 'page:index#s02-hero-hello',
      round: 1,
    });
    expect(text).toContain('round 1 of 6');
    // the gate as a number the worker can read off: the builder's task names the fraction, not
    // the word "threshold" the reviewer's brief still uses
    expect(text).toContain('at or under 0.001 of the compared pixels');
    expect(text).toContain('src/features/index/components/s02-hero-hello.tsx');
    expect(text).toContain('src/app/page.tsx');
    expect(text).toContain('`s02-hero-hello`');
    expect(text).toContain('x 0, y 72, w 1440, h 640');
    expect(text).toContain(
      path.join(root, 'pages', 'index', 'desktop', 'section-s02-hero-hello.png'),
    );
    expect(text).toContain(path.join(root, 'pages', 'index', 'styles.json'));
    // the ref table: the section's own elements, not the header's
    expect(text).toContain(`| \`${HERO}>h1:nth-of-type(1)\` | \`r3\` | h1 |`);
    expect(text).not.toContain('`r1`');
    expect(text).toContain('"font-size": "48px"');
    expect(text).toContain('fadeIn');
    expect(text).toContain('Fixture 400 normal -> src/assets/fonts/font-abc-Fixture-Regular.woff2');
    expect(text).toContain('rgb(37, 99, 235)');
    expect(text).toContain('data-section="s02-hero-hello"');
    expect(text).toContain('data-ref');
    // rule 1 lists allowedFilesFor's own entries, and says where a shared primitive goes now
    // that there is no bare src/components/ to put one in
    expect(text).toContain('a shared primitive goes in `src/components/ui/`');
    expect(text).toContain('   - /b/src/components/ui/');
    expect(text).not.toContain('   - /b/src/components/\n');
    // the theme the scaffold generated is named by its classes, so the worker reaches for a
    // token before an arbitrary value, and the two gate rules keep their negatives
    expect(text).toContain('## how to work');
    expect(text).toContain('`pack-2563eb` (#2563eb)');
    expect(text).toContain('`font-fixture`');
    expect(text).toContain('`animate-fadeIn`');
    expect(text).toContain('read-only');
    // the styles dir is off the allowed list too, and the brief points at fonts.css twice: it
    // says so where it says the theme is generated, with the way out beside it
    expect(text).toContain(
      '(`src/styles/`, globals and fonts) are generated from the pack and read-only',
    );
    expect(text).toContain('the read-only `src/styles/fonts.css`');
    expect(text).toContain('text-[48px]');
    expect(text).toContain('never `next/font`');
    expect(text).toContain(
      'site shot --pack ' +
        root +
        ' --unit page:index#s02-hero-hello --target http://127.0.0.1:3000 --out /r/round-1/shots',
    );
    expect(text).toContain('/r/round-1/shots/<viewport>.s02-hero-hello.png');
    expect(text).toContain('masked out of the pixel comparison');
    expect(text).not.toContain('tailwind.config.cjs` or');
    expect(text).toContain('never in a css module');
    expect(text).toContain('npx tsc --noEmit');
    // the gate the worker judges at is the round's, not the default: with --threshold given,
    // a rule without it would have the worker stopping at a score the orchestrator fails
    expect(text).toContain(
      `site verify --pack ${root} --unit page:index#s02-hero-hello --target http://127.0.0.1:3000 --gate 0.001`,
    );
    // the two commands are run as printed: the allowlist matches the text, and on the real
    // binary every denied call was this command decorated (quotes, `cd` in front, an absolute
    // binary, a pipe after). a tail of its own matters too: a `--out` into the pack would have
    // verify clearing artefacts where the capture lives
    // the chaining clause is the final real run's one denial: `site verify ... ; echo "EXIT:$?"`
    const asPrinted =
      'run it exactly as printed, character for character: no quotes around the paths, no `cd` in front, no other spelling of the binary, no flag added, moved or dropped (`--out` included), nothing piped or redirected after, no `;` or `&&` chaining before or after; the allowlist matches the text, and anything else is denied';
    expect(text.split(asPrinted)).toHaveLength(4);
    for (const sentence of [
      `Read them next to the source pngs and fix what differs. ${asPrinted}.`,
      `taller or shorter than the source. ${asPrinted}.`,
      `no \`npm install\`, no \`git\`. for those two commands, ${asPrinted}`,
    ]) {
      expect(text, sentence).toContain(sentence);
    }
    expect(text).toContain('"filesTouched"');
    expect(text).not.toContain('## the previous round');
  });

  it('carries the previous round: the verify summary, the artefacts and the reviewer reasons', async () => {
    const verify: VerifyResult = {
      unitId: 'page:index#s02-hero-hello',
      target: 'http://127.0.0.1:3000',
      verdict: 'fail',
      gate: 0.001,
      pixel: {
        mobile: null,
        desktop: {
          score: 0.31,
          mismatched: 3100,
          total: 10000,
          diffPng: '/r/round-1/verify/s02-hero-hello.desktop.diff.png',
          contactSheet: '/r/round-1/verify/s02-hero-hello.desktop.sheet.png',
        },
      },
      heightDelta: { mobile: null, desktop: 12 },
      styles: [
        {
          path: `${HERO}>h1:nth-of-type(1)`,
          ref: 'r3',
          viewport: 'desktop',
          property: 'font-size',
          expected: '48px',
          actual: '40px',
        },
      ],
      structure: [],
      animations: [],
      frames: [],
      missing: [],
      artefacts: [
        '/r/round-1/verify/s02-hero-hello.desktop.diff.png',
        '/r/round-1/verify/verify.json',
      ],
    };
    const text = await builderBrief(
      input('page:index#s02-hero-hello', {
        verify,
        reviewerReasons: ['the image is a placeholder'],
        reason: 'verify failed: pixel 31.000%',
      }),
    );
    expect(text).toContain('## the previous round');
    expect(text).toContain('pixel 31.000%');
    // once, in the fenced summary; the bullets under it only repeated what it already said
    expect(count(text, 'font-size: expected 48px, got 40px')).toBe(1);
    expect(text).toContain('/r/round-1/verify/s02-hero-hello.desktop.diff.png');
    expect(text).toContain('- the image is a placeholder');
  });

  it('names no crop png at a viewport the section had no box at', async () => {
    const alt = await fs.mkdtemp(path.join(os.tmpdir(), 'site-brief-'));
    const altManifest = await synthPack(alt);
    const file = path.join(alt, 'pages', 'index', 'sections.json');
    const sections = await readJson(SectionsFileSchema, file);
    sections[1]!.bbox.mobile = null;
    await writeJson(file, sections);
    const text = await builderBrief({
      ...input('page:index#s02-hero-hello'),
      root: alt,
      manifest: altManifest,
    });
    const crop = (vp: string) => path.join(alt, 'pages', 'index', vp, 'section-s02-hero-hello.png');
    expect(text).not.toContain(crop('mobile'));
    expect(text).toContain(crop('desktop'));
    expect(text).toContain(path.join(alt, 'pages', 'index', 'mobile', 'full.png'));
    await fs.rm(alt, { recursive: true, force: true });
  });

  it('names full.png only at a viewport the unit was reachable at', async () => {
    const full = (vp: string) => path.join(root, 'pages', 'index', 'states', 'modal-open', vp);
    // the no-op negative: no `reachable` on the record means every viewport, as the schema says
    const both = await builderBrief(input('state:index/modal-open'));
    expect(both).toContain(path.join(full('mobile'), 'full.png'));
    expect(both).toContain(path.join(full('desktop'), 'full.png'));
    // a state only the phone pass reached has no desktop shot on disk, and verify skips the
    // viewport: a brief that named the png would send the worker looking for it
    const mobileOnly = structuredClone(manifest);
    mobileOnly.units['state:index/modal-open']!.reachable = ['mobile'];
    const text = await builderBrief({
      ...input('state:index/modal-open'),
      manifest: mobileOnly,
    });
    expect(text).toContain(path.join(full('mobile'), 'full.png'));
    expect(text).not.toContain(path.join(full('desktop'), 'full.png'));
  });

  it('refuses a section id the pack does not have', async () => {
    await expect(builderBrief(input('page:index#s09-nope'))).rejects.toThrow(
      /s09-nope is not in the pack/,
    );
  });

  it('briefs a page, a state and a flow step by what they are', async () => {
    const page = await builderBrief(input('page:index'));
    expect(page).toContain('every section in order');
    expect(page).toContain('1. `s01-header`');
    expect(page).toContain('2. `s02-hero-hello`');
    expect(page).toContain('spacing between sections');
    const state = await builderBrief(input('state:index/modal-open'));
    expect(state).toContain('click button "Open"');
    expect(state).toContain('src/features/index/components');
    const step = await builderBrief(input('flow:signup/step-01-click-open'));
    expect(step).toContain('step 1 of flow `signup`');
    expect(step).toContain('src/features/signup/components/step-01-click-open.tsx');
    // a chrome section is told where the shared markup lives, and to build it there
    const header = await builderBrief(input('page:index#s01-header'));
    expect(header).toContain('src/components/layouts/site-header.tsx');
    expect(header).toContain('the markup and the styles go there');
    // a page's brief names the layouts dir in the rules (whose dir it is) and no layout file
    expect(page).not.toContain('site-header.tsx');
  });

  it('counts the masked regions inside the unit, not the page', async () => {
    // the no-op negative: a page owns every mask the capture found on it
    const page = await builderBrief(input('page:index'));
    expect(page).toContain('regions masked out of the pixel comparison: mobile 0, desktop 1');
    // the hero's box covers the one masked region, and the header's box sits above it
    const hero = await builderBrief(input('page:index#s02-hero-hello'));
    expect(hero).toContain('regions masked out of the pixel comparison: mobile 0, desktop 1');
    const header = await builderBrief(input('page:index#s01-header'));
    expect(header).toContain('regions masked out of the pixel comparison: mobile 0, desktop 0');
  });
});

describe('reviewerBrief', () => {
  // the mobile viewport was not compared, so verify copied no ours.mobile png: the brief may
  // name only what is in artefacts
  const ARTEFACTS = [
    '/v/s02.desktop.diff.png',
    '/v/ours.desktop.full.png',
    '/v/ours.desktop.s02-hero-hello.png',
    '/v/verify.json',
  ];
  const verify: VerifyResult = {
    unitId: 'page:index#s02-hero-hello',
    target: 'http://127.0.0.1:3000',
    verdict: 'pass',
    gate: 0.001,
    pixel: {
      mobile: null,
      desktop: {
        score: 0,
        mismatched: 0,
        total: 1,
        diffPng: '/v/s02.desktop.diff.png',
        contactSheet: '/v/s02.desktop.sheet.png',
      },
    },
    heightDelta: { mobile: null, desktop: 0 },
    styles: [],
    structure: [],
    animations: [],
    frames: [],
    missing: [],
    artefacts: ARTEFACTS,
  };
  const input = (unitId: string) => ({
    root,
    manifest,
    unitId,
    round: 2,
    rounds: 6,
    project: '/b',
    target: 'http://127.0.0.1:3000',
    threshold: 0.001,
    shotsDir: '/r/round-2/shots',
    previous: null,
    verify,
    builder: {
      summary: 'built the hero',
      filesTouched: ['src/features/index/components/s02-hero-hello.tsx'],
      notes: 'used the png',
    },
  });

  it('points the reviewer at source, ours and diff, quotes the builder, and fixes the verdict shape', async () => {
    const text = await reviewerBrief(input('page:index#s02-hero-hello'));
    expect(parseBriefHeader(text)).toEqual({
      role: 'reviewer',
      unit: 'page:index#s02-hero-hello',
      round: 2,
    });
    expect(text).toContain(
      path.join(root, 'pages', 'index', 'desktop', 'section-s02-hero-hello.png'),
    );
    expect(text).toContain('- ours: /v/ours.desktop.s02-hero-hello.png');
    expect(text).toContain('- verify: /v/s02.desktop.diff.png');
    // every artefact once, and nothing verify did not write
    for (const a of ARTEFACTS) expect(count(text, a)).toBe(1);
    expect(text).not.toContain('ours.mobile');
    expect(text).toContain('built the hero');
    expect(text).toContain('do not edit');
    expect(text).toContain('## how to look');
    expect(text).toContain('reject only for a difference you can name');
    expect(text).toContain('"verdict"');
    // a chrome section's reviewer is told where the shared markup lives, and nothing about
    // building it there: an instruction is the builder's brief, not this one's
    const chrome = await reviewerBrief(input('page:index#s01-header'));
    expect(chrome).toContain('src/components/layouts/site-header.tsx');
    expect(chrome).not.toContain('the markup and the styles go there');
    expect(text).toContain(SYNTH_URL);
  });

  it('refuses a section id the pack does not have', async () => {
    await expect(reviewerBrief(input('page:index#s09-nope'))).rejects.toThrow(
      /s09-nope is not in the pack/,
    );
  });
});
