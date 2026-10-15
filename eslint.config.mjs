import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import hooks from 'eslint-plugin-react-hooks'
import refresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'vendor/opencv/*.mjs',
      'out/**',
      'dist/**',
      'artifacts/**',
      'test-results/**',
      'playwright-report/**',
      '.codex/**',
      '.agents/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: ['src/main/**/*.ts'],
    ignores: ['src/main/window-presentation.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="BrowserWindow"]',
          message:
            'Create application windows through createAppWindow so automated launches stay hidden.',
        },
        {
          selector: 'NewExpression[callee.property.name="BrowserWindow"]',
          message:
            'Create application windows through createAppWindow so automated launches stay hidden.',
        },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': hooks, 'react-refresh': refresh },
    rules: {
      ...hooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  prettier,
)
