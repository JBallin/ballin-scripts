import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const commonGlobals = {
  ...globals.node,
  ...globals.mocha,
};

const jsRules = {
  ...js.configs.recommended.rules,
  'no-console': 'error',
};
const tsFiles = ['commands/**/*.ts', 'config/**/*.ts', 'test/**/*.ts'];

export default tseslint.config(
  {
    ignores: ['coverage/**'],
  },
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: commonGlobals,
    },
    rules: jsRules,
  },
  {
    files: ['**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: jsRules,
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: tsFiles,
  })),
  {
    files: tsFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: commonGlobals,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'error',
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': 'error',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
