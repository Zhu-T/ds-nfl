import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // apps/desktop/resources holds a staged copy of the built web app, test
    // files and all. Collecting from there runs every test twice, and the copy
    // fails because its tsconfig cannot resolve the workspace base.
    exclude: ['**/node_modules/**', '**/.next/**', 'apps/desktop/**'],
    environment: 'node',
  },
});
