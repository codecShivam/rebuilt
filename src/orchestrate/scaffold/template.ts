/**
 * the files the scaffold writes itself. the snapshot's versions pin the dependencies; the
 * text here is the bulletproof shape with the demo removed: no auth, no react-query, no
 * mocks, no storybook. a pixel clone sets every style itself, so the theme starts empty and
 * task 7 fills it from the pack.
 */

/** dependencies kept from the snapshot's package.json, with its versions */
export const KEEP_DEPENDENCIES = [
  'next',
  'react',
  'react-dom',
  'clsx',
  'tailwind-merge',
  'tailwindcss-animate',
  'eslint-plugin-check-file',
];
export const KEEP_DEV_DEPENDENCIES = [
  '@types/node',
  '@types/react',
  '@types/react-dom',
  '@typescript-eslint/eslint-plugin',
  '@typescript-eslint/parser',
  'autoprefixer',
  'eslint',
  'eslint-config-next',
  'eslint-config-prettier',
  'eslint-import-resolver-typescript',
  'eslint-plugin-import',
  'eslint-plugin-jsx-a11y',
  'eslint-plugin-prettier',
  'eslint-plugin-react',
  'eslint-plugin-react-hooks',
  'eslint-plugin-tailwindcss',
  'postcss',
  'prettier',
  'tailwindcss',
  'typescript',
];

export interface SnapshotPackage {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function pick(from: Record<string, string>, keep: string[], what: string): Record<string, string> {
  return Object.fromEntries(
    keep.map((k) => {
      const v = from[k];
      if (!v) throw new Error(`the snapshot's package.json has no ${k} under ${what}`);
      return [k, v];
    }),
  );
}

export function packageJson(snapshot: SnapshotPackage, name: string): string {
  return (
    JSON.stringify(
      {
        name,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          dev: 'next dev',
          build: 'next build',
          start: 'next start',
          lint: 'next lint',
          'check-types': 'tsc --noEmit',
        },
        dependencies: pick(snapshot.dependencies, KEEP_DEPENDENCIES, 'dependencies'),
        devDependencies: pick(snapshot.devDependencies, KEEP_DEV_DEPENDENCIES, 'devDependencies'),
      },
      null,
      2,
    ) + '\n'
  );
}

/** what the pack puts into tailwind's theme.extend */
export interface ThemeTokens {
  colors: Record<string, string>;
  fontFamily: Record<string, string[]>;
  keyframes: Record<string, Record<string, Record<string, string>>>;
  animation: Record<string, string>;
}
// the theme a scaffold with no pack starts from. generate.ts's tokensFrom fills these from the
// pack's colours, fonts and keyframes, and orchestrate/brand.ts's applyBrandTokens layers a
// brand.json over that (the brand phase): an overridden token keeps its name and takes the
// brand's value, so the classes in the components never change
export const EMPTY_TOKENS: ThemeTokens = {
  colors: {},
  fontFamily: {},
  keyframes: {},
  animation: {},
};

export function tailwindConfig(tokens: ThemeTokens): string {
  const block = (v: unknown) => JSON.stringify(v, null, 2).replace(/\n/g, '\n      ');
  return `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: ${block(tokens.colors)},
      fontFamily: ${block(tokens.fontFamily)},
      keyframes: ${block(tokens.keyframes)},
      animation: ${block(tokens.animation)},
    },
  },
  plugins: [require('tailwindcss-animate')],
};
`;
}

/** the snapshot's eslint config minus the test stack, with one no-cross-imports zone per feature */
export function eslintConfig(features: string[]): string {
  const zones = features
    .map(
      (f) => `              {
                target: './src/features/${f}',
                from: './src/features',
                except: ['./${f}'],
              },`,
    )
    .join('\n');
  // claude: bulletproof's own folder-naming-convention keys are inert as written. the rule
  // validates only what `micromatch.capture(<key>, <folder path>)` returns, and a folder path
  // ends in a slash while both keys end in `*`, so capture is undefined for every folder and
  // nothing is ever checked (probed against check-file 2.8.0 and its micromatch). the slug
  // alphabet below is what the rule means to say; milestone 5 decides whether to make the key
  // fire (`'!(src/app)/**'`) and take the findings that come with it.
  return `module.exports = {
  root: true,
  env: {
    node: true,
    es6: true,
  },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  ignorePatterns: ['node_modules/*', '.next/*'],
  extends: ['eslint:recommended', 'next/core-web-vitals'],
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      parser: '@typescript-eslint/parser',
      settings: {
        react: { version: 'detect' },
        'import/resolver': {
          typescript: {},
        },
      },
      env: {
        browser: true,
        node: true,
        es6: true,
      },
      extends: [
        'eslint:recommended',
        'plugin:import/errors',
        'plugin:import/warnings',
        'plugin:import/typescript',
        'plugin:@typescript-eslint/recommended',
        'plugin:react/recommended',
        'plugin:react-hooks/recommended',
        'plugin:jsx-a11y/recommended',
        'plugin:prettier/recommended',
        'plugin:tailwindcss/recommended',
      ],
      rules: {
        '@next/next/no-img-element': 'off',
        'import/no-restricted-paths': [
          'error',
          {
            zones: [
              // no cross-feature imports: one zone per feature
${zones}
              // unidirectional: app imports features, never the other way
              {
                target: './src/features',
                from: './src/app',
              },
              // shared modules import neither features nor app
              {
                target: [
                  './src/components',
                  './src/hooks',
                  './src/lib',
                  './src/types',
                  './src/utils',
                ],
                from: ['./src/features', './src/app'],
              },
            ],
          },
        ],
        'import/no-cycle': 'error',
        'linebreak-style': ['error', 'unix'],
        'react/prop-types': 'off',
        'import/order': [
          'error',
          {
            groups: [
              'builtin',
              'external',
              'internal',
              'parent',
              'sibling',
              'index',
              'object',
            ],
            'newlines-between': 'always',
            alphabetize: { order: 'asc', caseInsensitive: true },
          },
        ],
        'import/default': 'off',
        'import/no-named-as-default-member': 'off',
        'import/no-named-as-default': 'off',
        'react/react-in-jsx-scope': 'off',
        'jsx-a11y/anchor-is-valid': 'off',
        // a pixel clone names classes the theme does not know; the compiler, not the linter, checks them
        'tailwindcss/no-custom-classname': 'off',
        '@typescript-eslint/no-unused-vars': ['error'],
        '@typescript-eslint/explicit-function-return-type': ['off'],
        '@typescript-eslint/explicit-module-boundary-types': ['off'],
        '@typescript-eslint/no-empty-function': ['off'],
        '@typescript-eslint/no-explicit-any': ['off'],
        'prettier/prettier': ['error', {}, { usePrettierrc: true }],
      },
    },
    {
      plugins: ['check-file'],
      files: ['src/**/*'],
      rules: {
        'check-file/filename-naming-convention': [
          'error',
          {
            '**/*.{ts,tsx}': 'KEBAB_CASE',
          },
          {
            ignoreMiddleExtensions: true,
          },
        ],
        // a feature dir is the page's slug, which joins url path segments with a double
        // hyphen and may start with a digit (/blog/hello, /2024/report): the slug alphabet,
        // not KEBAB_CASE, which admits neither
        'check-file/folder-naming-convention': [
          'error',
          {
            '!(src/app)/**/*': '+([a-z0-9])*(-*([a-z0-9]))',
            '!(**/__tests__)/**/*': 'KEBAB_CASE',
          },
        ],
      },
    },
  ],
};
`;
}

export function layoutFile(title: string): string {
  return `import { ReactNode } from 'react';

import { AppProvider } from '@/app/provider';

import '@/styles/globals.css';
import '@/styles/fonts.css';

export const metadata = {
  title: '${title.replace(/'/g, "\\'")}',
};

const RootLayout = ({ children }: { children: ReactNode }) => {
  return (
    <html lang="en">
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
};

export default RootLayout;
`;
}

/** files written as they are, keyed by their path in the project */
export const GENERATED: Record<string, string> = {
  'next.config.mjs': `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // phase one is a pixel clone: next's re-encoding of an image shifts pixels
  images: { unoptimized: true },
};

export default nextConfig;
`,
  'src/app/provider.tsx': `'use client';

import * as React from 'react';

import { MainErrorFallback } from '@/components/errors/main';

type AppProviderProps = {
  children: React.ReactNode;
};

type BoundaryState = {
  failed: boolean;
};

/**
 * bulletproof wraps the app in react-error-boundary; a pixel clone carries no
 * dependency it does not render, so the boundary is react's own two methods on
 * a class component, with the same fallback.
 */
class ErrorBoundary extends React.Component<AppProviderProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <MainErrorFallback /> : this.props.children;
  }
}

export const AppProvider = ({ children }: AppProviderProps) => {
  return <ErrorBoundary>{children}</ErrorBoundary>;
};
`,
  'src/app/page.tsx': `const HomePage = () => {
  return (
    <main>
      <section data-section="placeholder" className="min-h-20 p-8">
        <h1>site scaffold</h1>
        <p>run site scaffold with --pack to generate this page from a pack.</p>
      </section>
    </main>
  );
};

export default HomePage;
`,
  'src/app/not-found.tsx': `import Link from 'next/link';

import { paths } from '@/config/paths';

const NotFoundPage = () => {
  return (
    <div className="mt-52 flex flex-col items-center font-semibold">
      <h1>404 - Not Found</h1>
      <p>Sorry, the page you are looking for does not exist.</p>
      <Link href={paths.home.getHref()} replace>
        Go to Home
      </Link>
    </div>
  );
};

export default NotFoundPage;
`,
  'src/components/errors/main.tsx': `'use client';

export const MainErrorFallback = () => {
  return (
    <div
      className="flex h-screen w-screen flex-col items-center justify-center text-red-500"
      role="alert"
    >
      <h2 className="text-lg font-semibold">Ooops, something went wrong :( </h2>
      <button
        className="mt-4"
        onClick={() => window.location.assign(window.location.origin)}
      >
        Refresh
      </button>
    </div>
  );
};
`,
  'src/config/paths.ts': `export const paths = {
  home: {
    getHref: () => '/',
  },
} as const;
`,
  'src/styles/globals.css': `@tailwind base;
@tailwind components;
@tailwind utilities;

/* the pack's fonts are declared in fonts.css; every other style is a section's own */
body {
  margin: 0;
}
`,
  'src/styles/fonts.css': `/* @font-face rules generated from the pack; empty until a pack is generated */
`,
};

/** dirs the bulletproof shape has and the blank scaffold keeps, with a .gitkeep each */
export const EMPTY_DIRS = [
  'src/assets/fonts',
  'src/components/layouts',
  'src/components/ui',
  'src/features',
  'src/lib',
  'src/testing',
  'src/types',
];
