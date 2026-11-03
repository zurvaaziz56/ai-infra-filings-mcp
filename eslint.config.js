import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'data/', 'logs/', 'coverage/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }] } },
);
