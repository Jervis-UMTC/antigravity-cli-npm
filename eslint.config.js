import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', 'build/**']
  },
  {
    files: ['bin/**/*.js', 'src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        fetch: 'readonly',
        AbortController: 'readonly',
        TextDecoder: 'readonly'
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }]
    }
  }
];
