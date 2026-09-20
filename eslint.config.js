import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

// module direction: cli -> verify -> capture -> pack. a zone names a directory (target) and
// what it may not import (from). orchestrate is reserved for milestone 4 and already fenced.
const zones = [
  { target: './src/pack', from: './src/capture', message: 'pack imports nothing from capture' },
  { target: './src/pack', from: './src/verify', message: 'pack imports nothing from verify' },
  { target: './src/pack', from: './src/cli', message: 'pack imports nothing from cli' },
  {
    target: './src/pack',
    from: './src/orchestrate',
    message: 'pack imports nothing from orchestrate',
  },
  { target: './src/capture', from: './src/verify', message: 'capture imports pack only' },
  { target: './src/capture', from: './src/cli', message: 'capture imports pack only' },
  { target: './src/capture', from: './src/orchestrate', message: 'capture imports pack only' },
  { target: './src/verify', from: './src/cli', message: 'verify imports pack and capture only' },
  {
    target: './src/verify',
    from: './src/orchestrate',
    message: 'verify imports pack and capture only',
  },
  { target: './src/orchestrate', from: './src/cli', message: 'orchestrate never imports cli' },
];

export default tseslint.config(
  { ignores: ['node_modules/', 'sites/', 'builds/', 'docs/', '.superpowers/', 'test/fixtures/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts'],
    plugins: { import: importPlugin },
    settings: { 'import/resolver': { node: { extensions: ['.ts', '.js'] } } },
    rules: {
      'import/no-restricted-paths': ['error', { zones }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // the codebase uses `!` deliberately after a guard it just wrote; the rule would only add noise
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // only orchestrate spawns a process (claude, the dev server, the compile checks); the one
    // exception below it is the ffmpeg call. the fence names every way to reach a process and
    // denies by default, so a module added later is fenced without anyone remembering to list it.
    files: ['src/**/*.ts'],
    ignores: ['src/orchestrate/**/*.ts', 'src/capture/motion.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['execa', 'node:child_process', 'child_process'].map((name) => ({
            name,
            message: 'only src/orchestrate spawns processes (src/capture/motion.ts runs ffmpeg)',
          })),
        },
      ],
    },
  },
);
