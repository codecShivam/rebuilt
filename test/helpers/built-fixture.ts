import fs from 'node:fs/promises';
import path from 'node:path';

/** the fixture's one image, as the scaffold copies it: `image-<hash>-hero.png`, the hash from the url */
export const BUILT_HERO_SUFFIX = '-hero.png';

const HEADER = `type SiteHeaderProps = { sectionId: string };

const menuLink = { display: 'block', padding: '8px 16px' } as const;

export const SiteHeader = ({ sectionId }: SiteHeaderProps) => {
  return (
    <header data-section={sectionId} className="min-h-20">
      <a href="/">Fixture Co</a>
      <button aria-label="Menu" aria-expanded={false} aria-controls="drawer">
        <span />
        <span />
        <span />
      </button>
      <nav aria-label="Main">
        <ul>
          <li>
            <button aria-haspopup="true" aria-expanded={false}>
              Products
            </button>
            <ul hidden>
              <li>
                <a href="/about.html" style={menuLink}>
                  Scanner
                </a>
              </li>
              <li>
                <a href="/about.html" style={menuLink}>
                  Monitor
                </a>
              </li>
            </ul>
          </li>
          <li>
            <a href="/about.html">About</a>
          </li>
        </ul>
      </nav>
      <div id="drawer" hidden>
        <a href="/about.html">About</a>
        <a href="/about.html">Privacy</a>
      </div>
    </header>
  );
};
`;

const FOOTER = `type SiteFooterProps = { sectionId: string };

export const SiteFooter = ({ sectionId }: SiteFooterProps) => {
  return (
    <footer data-section={sectionId} className="min-h-20">
      <p>Fixture Co, 1 Example Street</p>
      <ul>
        <li>
          <a href="/about.html">About</a>
        </li>
        <li>
          <a href="/about.html">Privacy</a>
        </li>
      </ul>
    </footer>
  );
};
`;

const hero = (heroFile: string) => `import hero from '@/assets/${heroFile}';

const button = { display: 'inline-block', padding: '12px 24px' } as const;

export const S02HeroKnowBeforeYouGo = () => {
  return (
    <section data-section="s02-hero-know-before-you-go" className="min-h-20">
      <span>New</span>
      <h1>Know before you go</h1>
      <p>Fixture Co checks every detail so you never have to guess.</p>
      <p>
        Checks today: <strong id="counter">0</strong>
      </p>
      <a href="/about.html" style={button}>
        Start free
      </a>
      <img src={hero.src} alt="Product screenshot" width={480} height={270} />
    </section>
  );
};
`;

const FEATURES = `export const S03FeaturesEverythingYouNeed = () => {
  return (
    <section
      data-section="s03-features-everything-you-need"
      className="min-h-20"
    >
      <h2>Everything you need</h2>
      <ul>
        <li>
          <h3>Fast scans</h3>
          <p>Results in under a minute, every time.</p>
        </li>
        <li>
          <h3>Deep records</h3>
          <p>Public data from over two hundred sources.</p>
        </li>
        <li>
          <h3>Private by design</h3>
          <p>Nothing is stored after you close the tab.</p>
        </li>
      </ul>
    </section>
  );
};
`;

const FAQ = `export const S04FaqQuestions = () => {
  return (
    <section data-section="s04-faq-questions" className="min-h-20">
      <h2>Questions</h2>
      <details>
        <summary>Is it accurate?</summary>
        <p>
          Accuracy depends on the sources, and we show you which ones matched.
        </p>
      </details>
      <details>
        <summary>Can I cancel?</summary>
        <p>Any time, from your account page, with one click.</p>
      </details>
      <details>
        <summary>Do you store data?</summary>
        <p>No. Reports are generated on demand and discarded.</p>
      </details>
    </section>
  );
};
`;

const CTA = `export const S05CtaReadyWhenYouAre = () => {
  return (
    <section data-section="s05-cta-ready-when-you-are" className="min-h-20">
      <h2>Ready when you are</h2>
      <button id="open-modal">Talk to us</button>
    </section>
  );
};
`;

/**
 * the fixture's index page rebuilt by hand: the markup of test/fixtures/site/index.html (the
 * modal left out, it is no section) as the components the scaffold's mapping names, so the
 * structure diff over the rebuild sees the fixture's own sections, items, buttons and image
 * counts. no pixel fidelity: the brand gate never looks at pixels. the shared chrome goes into
 * the layouts the scaffold wrote for the two-page pack (index and about), so the about page
 * keeps its stubs and still matches its own three sections. the extractor calls an anchor a
 * button by its computed display and left padding, so those two are inline styles; the section
 * height is the one class the stubs already carry (80 css px, the extractor's floor). the
 * text is in the shape the project's prettier prints, so `next lint` is clean before any
 * format runs.
 */
export function builtIndexFiles(heroFile: string): Record<string, string> {
  return {
    'src/components/layouts/site-header.tsx': HEADER,
    'src/components/layouts/site-footer.tsx': FOOTER,
    'src/features/index/components/s02-hero-know-before-you-go.tsx': hero(heroFile),
    'src/features/index/components/s03-features-everything-you-need.tsx': FEATURES,
    'src/features/index/components/s04-faq-questions.tsx': FAQ,
    'src/features/index/components/s05-cta-ready-when-you-are.tsx': CTA,
  };
}

/** the built index written over a scaffold of the fixture pack; the hero image is looked up by its suffix */
export async function writeBuiltIndex(project: string): Promise<string[]> {
  const assets = await fs.readdir(path.join(project, 'src', 'assets'));
  const heroFile = assets.find((n) => n.endsWith(BUILT_HERO_SUFFIX));
  if (!heroFile) throw new Error(`${project}/src/assets has no *${BUILT_HERO_SUFFIX}`);
  const files = builtIndexFiles(heroFile);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(project, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  return Object.keys(files).sort();
}
