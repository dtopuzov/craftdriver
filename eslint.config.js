// @ts-check
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import tsParser from '@typescript-eslint/parser';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  {
    ignores: [
      'dist/**',
      'examples/**',
      'selenium-webdriver/**',
      'rust/**',
      'tests/**',
      'vitest.config.ts',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];
