import { describe, it, expect } from 'vitest';
import { normaliseOffset, parseStylesheet, unquote } from '../../src/capture/css';

const CSS = `
@import url("a.css") screen and (min-width: 600px);
@import 'b.css';
@font-face { font-family: 'Fixture'; src: url('/fonts/Fixture-Regular.woff2') format('woff2'), url(/fonts/Fixture-Regular.woff); font-weight: 400; font-style: normal; }
@font-face { font-family: Fixture; src: local('Fixture'), url("https://cdn.example/f.woff2?v=2#iefix") format("woff2"); font-weight: 100 900; }
@keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.08) } 100% { transform: scale(1); } }
@-webkit-keyframes fadeIn { from, 20% { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
@media (max-width: 600px) { @keyframes slide { from { left: -100px } to { left: 0 } } }
.x { color: #fff }
`;

describe('parseStylesheet', () => {
  it('finds nothing in a stylesheet with no keyframes, faces or imports', () => {
    expect(parseStylesheet('.x { color: red }', 'http://x.test/a.css')).toEqual({
      keyframes: {},
      fontFaces: [],
      imports: [],
      parseErrors: 0,
    });
  });

  it('recovers keyframes with cssom-style offsets, one stop per selector', () => {
    const r = parseStylesheet(CSS, 'http://x.test/css/site.css');
    expect(Object.keys(r.keyframes).sort()).toEqual(['fadeIn', 'pulse', 'slide']);
    expect(r.keyframes['pulse']).toEqual([
      { offset: '0%', declarations: { transform: 'scale(1)' } },
      { offset: '50%', declarations: { transform: 'scale(1.08)' } },
      { offset: '100%', declarations: { transform: 'scale(1)' } },
    ]);
    expect(r.keyframes['fadeIn']!.map((s) => s.offset)).toEqual(['0%', '20%', '100%']);
    expect(r.keyframes['fadeIn']![0]!.declarations).toEqual({
      opacity: '0',
      transform: 'translateY(24px)',
    });
    expect(r.keyframes['slide']).toEqual([
      { offset: '0%', declarations: { left: '-100px' } },
      { offset: '100%', declarations: { left: '0' } },
    ]);
  });

  it('resolves font-face src urls against the stylesheet url and keeps weight ranges', () => {
    const r = parseStylesheet(CSS, 'http://x.test/css/site.css');
    expect(r.fontFaces).toEqual([
      {
        family: 'Fixture',
        weight: '400',
        style: 'normal',
        urls: [
          'http://x.test/fonts/Fixture-Regular.woff2',
          'http://x.test/fonts/Fixture-Regular.woff',
        ],
      },
      {
        family: 'Fixture',
        weight: '100 900',
        style: 'normal',
        urls: ['https://cdn.example/f.woff2?v=2#iefix'],
      },
    ]);
  });

  it('lists imports with their media and resolved urls', () => {
    const r = parseStylesheet(CSS, 'http://x.test/css/site.css');
    expect(r.imports).toEqual([
      { url: 'http://x.test/css/a.css', media: 'screen and (min-width:600px)' },
      { url: 'http://x.test/css/b.css', media: '' },
    ]);
  });

  it('tolerates a broken rule and keeps the rest', () => {
    const r = parseStylesheet(
      '@keyframes ok { to { opacity: 1 } } @keyframes k { 50% { transform: rotate( } }',
      'http://x.test/a.css',
    );
    expect(r.keyframes['ok']).toEqual([{ offset: '100%', declarations: { opacity: '1' } }]);
  });

  it('recovers a rule after a broken one instead of losing it to end of sheet', () => {
    const r = parseStylesheet(
      '@keyframes k { 50% { transform: rotate( } } @font-face { font-family: X; src: url(a.woff2); }',
      'http://x.test/s.css',
    );
    expect(r.fontFaces).toEqual([
      { family: 'X', weight: '400', style: 'normal', urls: ['http://x.test/a.woff2'] },
    ]);
    expect(r.parseErrors).toBeGreaterThanOrEqual(1);
  });

  it('keeps both good keyframes around a broken rule sandwiched between them', () => {
    const r = parseStylesheet(
      '@keyframes a { to { opacity: 1 } } ' +
        '@keyframes bad { 50% { transform: rotate( } } ' +
        '@keyframes b { to { opacity: 0 } }',
      'http://x.test/a.css',
    );
    expect(r.keyframes['a']).toEqual([{ offset: '100%', declarations: { opacity: '1' } }]);
    expect(r.keyframes['b']).toEqual([{ offset: '100%', declarations: { opacity: '0' } }]);
    expect(r.parseErrors).toBeGreaterThanOrEqual(1);
  });

  it('keeps an absolute src url even when the stylesheet url is empty or invalid', () => {
    const r = parseStylesheet(
      '@font-face{font-family:X;src:url(https://cdn.example/x.woff2);}',
      '',
    );
    expect(r.fontFaces).toEqual([
      { family: 'X', weight: '400', style: 'normal', urls: ['https://cdn.example/x.woff2'] },
    ]);
  });

  it('skips a relative src url without throwing when the stylesheet url is empty', () => {
    const r = parseStylesheet('@font-face{font-family:X;src:url(a.woff2);}', '');
    expect(r.fontFaces).toEqual([{ family: 'X', weight: '400', style: 'normal', urls: [] }]);
  });

  it('unquotes and normalises offsets', () => {
    expect(unquote('"Fixture"')).toBe('Fixture');
    expect(unquote("'Fixture'")).toBe('Fixture');
    expect(unquote('Fixture')).toBe('Fixture');
    expect(normaliseOffset('from')).toBe('0%');
    expect(normaliseOffset('TO')).toBe('100%');
    expect(normaliseOffset(' 50% ')).toBe('50%');
  });
});
