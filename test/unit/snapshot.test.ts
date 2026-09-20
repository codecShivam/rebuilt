import { describe, it, expect } from 'vitest';
import { buildSnapshot, stripInlineScript } from '../../src/capture/snapshot';

const assets = {
  files: new Map<string, { data: Buffer; type: string }>([
    [
      'http://x.test/styles.css',
      { data: Buffer.from('body{background:url(/bg.png)}'), type: 'text/css' },
    ],
    ['http://x.test/bg.png', { data: Buffer.from([1, 2, 3]), type: 'image/png' }],
    ['http://x.test/hero.png', { data: Buffer.from([4, 5, 6]), type: 'image/png' }],
  ]),
  fileFor(url: string) {
    return this.files.has(url) ? url : null;
  },
  async readFile(file: string) {
    return this.files.get(file)!.data;
  },
  contentTypeFor(url: string) {
    return this.files.get(url)?.type ?? null;
  },
};

const SPRITE =
  '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="i"><circle r="4"/></symbol></svg>';
const CLOUDINARY_1X = Buffer.from([7]);
const CLOUDINARY_2X = Buffer.from([8]);
const QUERY_COMMA = Buffer.from([9]);
const extra = {
  files: new Map<string, { data: Buffer; type: string }>([
    ['http://x.test/img-1x.png', { data: Buffer.from([1]), type: 'image/png' }],
    ['http://x.test/img-2x.png', { data: Buffer.from([2]), type: 'image/png' }],
    ['http://x.test/sprite.svg', { data: Buffer.from(SPRITE), type: 'image/svg+xml' }],
    [
      'http://x.test/image/upload/c_fill,w_300/sample.jpg',
      { data: CLOUDINARY_1X, type: 'image/jpeg' },
    ],
    [
      'http://x.test/image/upload/c_fill,w_600/sample.jpg',
      { data: CLOUDINARY_2X, type: 'image/jpeg' },
    ],
    ['http://x.test/query.png?x=1,2', { data: QUERY_COMMA, type: 'image/png' }],
    [
      'http://x.test/main.css',
      {
        data: Buffer.from('@import url("/one.css") screen;\n@import "/cycle.css";\na{color:red}'),
        type: 'text/css',
      },
    ],
    [
      'http://x.test/one.css',
      { data: Buffer.from('p{background:url(/img-1x.png)}'), type: 'text/css' },
    ],
    [
      'http://x.test/cycle.css',
      { data: Buffer.from('@import "/main.css";\nb{}'), type: 'text/css' },
    ],
  ]),
  fileFor(url: string) {
    return this.files.has(url) ? url : null;
  },
  async readFile(file: string) {
    return this.files.get(file)!.data;
  },
  contentTypeFor(url: string) {
    return this.files.get(url)?.type ?? null;
  },
};

describe('buildSnapshot', () => {
  it('inlines stylesheets and images it has, and leaves unknown urls alone', async () => {
    const dom =
      '<html><head><link rel="stylesheet" href="/styles.css"></head><body><img src="/hero.png"><img src="/unknown.png"></body></html>';
    const out = await buildSnapshot(dom, 'http://x.test/', assets);
    expect(out).not.toContain('<link rel="stylesheet"');
    expect(out).toContain('<style>');
    expect(out).toContain('url(data:image/png;base64,AQID)');
    expect(out).toContain('src="data:image/png;base64,BAUG"');
    expect(out).toContain('src="/unknown.png"');
  });

  it('inlines the real src regardless of a decoy data-src on either side, and leaves data-src untouched', async () => {
    const dom =
      '<img data-src="/unknown.png" src="/hero.png"><source src="/hero.png" data-src="/unknown.png">';
    const out = await buildSnapshot(dom, 'http://x.test/', assets);
    expect(out).toContain('data-src="/unknown.png" src="data:image/png;base64,BAUG"');
    expect(out).toContain('src="data:image/png;base64,BAUG" data-src="/unknown.png"');
  });

  it('inlines a stylesheet found via href even with a decoy data-href present', async () => {
    const dom = '<link data-href="/nope.css" rel="stylesheet" href="/styles.css">';
    const out = await buildSnapshot(dom, 'http://x.test/', assets);
    expect(out).not.toContain('<link');
    expect(out).toContain('<style>');
    expect(out).toContain('url(data:image/png;base64,AQID)');
  });

  it('keeps a $ in css verbatim, from a linked stylesheet and from an inline block', async () => {
    const css = ".price::before{content:'$'}";
    const dollarAssets = {
      files: new Map<string, { data: Buffer; type: string }>([
        ['http://x.test/price.css', { data: Buffer.from(css), type: 'text/css' }],
      ]),
      fileFor(url: string) {
        return this.files.has(url) ? url : null;
      },
      async readFile(file: string) {
        return this.files.get(file)!.data;
      },
      contentTypeFor(url: string) {
        return this.files.get(url)?.type ?? null;
      },
    };
    // `$'` is the "portion after the match" pattern: as a replacement string it would paste
    // the rest of the document back in, duplicating everything after the <link>.
    const linkDom =
      '<html><head><link rel="stylesheet" href="/price.css"></head><body><p>after</p></body></html>';
    const linked = await buildSnapshot(linkDom, 'http://x.test/', dollarAssets);
    expect(linked).toContain(`<style>${css}</style>`);
    expect((linked.match(/<body>/g) ?? []).length).toBe(1);

    const inlineDom = `<html><head><style>${css}</style></head><body><p>after</p></body></html>`;
    const inline = await buildSnapshot(inlineDom, 'http://x.test/', dollarAssets);
    expect(inline).toBe(inlineDom);
    expect((inline.match(/<body>/g) ?? []).length).toBe(1);
  });

  it("resolves url() inside a linked stylesheet against the stylesheet's own url, not the page url", async () => {
    const deepAssets = {
      files: new Map<string, { data: Buffer; type: string }>([
        [
          'http://x.test/css/deep.css',
          { data: Buffer.from('body{background:url(../bg.png)}'), type: 'text/css' },
        ],
        ['http://x.test/bg.png', { data: Buffer.from([1, 2, 3]), type: 'image/png' }],
      ]),
      fileFor(url: string) {
        return this.files.has(url) ? url : null;
      },
      async readFile(file: string) {
        return this.files.get(file)!.data;
      },
      contentTypeFor(url: string) {
        return this.files.get(url)?.type ?? null;
      },
    };
    const dom = '<link rel="stylesheet" href="/css/deep.css">';
    const out = await buildSnapshot(dom, 'http://x.test/page/index.html', deepAssets);
    // ../bg.png resolved against http://x.test/css/deep.css is http://x.test/bg.png.
    // resolved against the page url it would be http://x.test/page/bg.png, which the store does not have.
    expect(out).toContain('url(data:image/png;base64,AQID)');
  });

  it('touches every new path without triggering any of them, and round-trips byte for byte', async () => {
    const dom =
      '<img srcset="/nope-1x.png 1x, /nope-2x.png 2x" src="/nope.png">' +
      '<svg><use href="#local"></use></svg>' +
      '<style>@import url("/missing.css");</style>' +
      '<div data-on-x="1">oncology</div>' +
      '<a href="/javascript-tutorial">x</a>';
    expect(await buildSnapshot(dom, 'http://x.test/', extra)).toBe(dom);
  });

  it('inlines every candidate of a srcset on an img and a picture source', async () => {
    const dom =
      '<picture><source srcset="/img-2x.png 2x, /nope.png 3x" media="(min-width: 600px)">' +
      '<img srcset="/img-1x.png 1x, /img-2x.png 2x" src="/img-1x.png"></picture>';
    const out = await buildSnapshot(dom, 'http://x.test/', extra);
    expect(out).toContain('srcset="data:image/png;base64,Ag== 2x, /nope.png 3x"');
    expect(out).toContain('srcset="data:image/png;base64,AQ== 1x, data:image/png;base64,Ag== 2x"');
    expect(out).toContain('src="data:image/png;base64,AQ=="');
  });

  it('inlines a cloudinary-style srcset whose urls hold a comma in their own path', async () => {
    const dom =
      '<img srcset="/image/upload/c_fill,w_300/sample.jpg 1x, ' +
      '/image/upload/c_fill,w_600/sample.jpg 2x">';
    const out = await buildSnapshot(dom, 'http://x.test/', extra);
    expect(out).toContain(
      `srcset="data:image/jpeg;base64,${CLOUDINARY_1X.toString('base64')} 1x, ` +
        `data:image/jpeg;base64,${CLOUDINARY_2X.toString('base64')} 2x"`,
    );
  });

  it('inlines a srcset url whose query string holds a comma', async () => {
    const dom = '<img srcset="/query.png?x=1,2 1x">';
    const out = await buildSnapshot(dom, 'http://x.test/', extra);
    expect(out).toContain(`srcset="data:image/png;base64,${QUERY_COMMA.toString('base64')} 1x"`);
  });

  it('follows @import recursively, wraps a media list, and stops at a cycle', async () => {
    const out = await buildSnapshot(
      '<link rel="stylesheet" href="/main.css">',
      'http://x.test/',
      extra,
    );
    expect(out).toContain('@media screen {\np{background:url(data:image/png;base64,AQ==)}\n}');
    expect(out).toContain('b{}');
    expect(out).not.toContain('@import');
    expect((out.match(/a\{color:red\}/g) ?? []).length).toBe(1);
  });

  it('looks a fragment url up without the fragment and keeps it on an svg only', async () => {
    const dom =
      '<style>.a{background:url(/img-1x.png#frag)}</style><svg><use href="/sprite.svg#i"></use></svg>';
    const out = await buildSnapshot(dom, 'http://x.test/', extra);
    expect(out).toContain('url(data:image/png;base64,AQ==)');
    expect(out).toContain(
      `href="data:image/svg+xml;base64,${Buffer.from(SPRITE).toString('base64')}#i"`,
    );
  });

  it('strips inline handlers and javascript: urls', () => {
    const html =
      '<a href="javascript:void(0)" onclick="go()">x</a>' +
      '<button onmouseover=\'h()\' data-one="keep">y</button>' +
      '<img src="/a.png" onerror=bad()>';
    expect(stripInlineScript(html)).toBe(
      '<a href="#">x</a><button data-one="keep">y</button><img src="/a.png">',
    );
  });

  it('strips a javascript: url hidden behind an embedded tab or newline', () => {
    const html =
      '<a href="jav\tascript:alert(1)">x</a>' +
      '<a href="java\nscript:alert(1)">y</a>' +
      '<a href="/javascript-tutorial">z</a>';
    expect(stripInlineScript(html)).toBe(
      '<a href="#">x</a><a href="#">y</a><a href="/javascript-tutorial">z</a>',
    );
  });

  it('writes a snapshot with no handlers in it', async () => {
    const out = await buildSnapshot(
      '<body><button onclick="open()">Talk to us</button></body>',
      'http://x.test/',
      extra,
    );
    expect(out).toBe('<body><button>Talk to us</button></body>');
  });
});
