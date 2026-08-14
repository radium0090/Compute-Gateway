import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/generated/**',
      '**/node_modules/**',
      'apps/gateway/public/**',
      'examples/**/*.mjs',
      'eslint.config.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@rax-digital/*/src', '@rax-digital/*/src/**'],
        },
      ],
    },
  },
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'fastify',
            'fastify/*',
            'pg',
            'pg/*',
            'pino',
            '@opentelemetry/*',
            '@rax-digital/provider-*',
            '@rax-digital/persistence-*',
            '@rax-digital/observability',
            '@rax-digital/*/src',
            '@rax-digital/*/src/**',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/provider-*/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@rax-digital/provider-*',
            '@rax-digital/*/src',
            '@rax-digital/*/src/**',
          ],
        },
      ],
    },
  },
);
