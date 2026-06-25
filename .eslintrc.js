module.exports = {
  extends: 'airbnb-base',
  env: {
    mocha: true,
  },
  overrides: [
    {
      files: ['**/*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'script',
      },
      plugins: ['@typescript-eslint'],
      rules: {
        'import/no-dynamic-require': 'off',
        'import/no-unresolved': 'off',
        'import/extensions': 'off',
        'no-use-before-define': 'off',
      },
    },
  ],
};
