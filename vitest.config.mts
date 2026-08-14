import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    alias: {
      // `server-only` throws outside a React Server Component graph. The data
      // layer imports it as a guard; under test it has nothing to guard.
      'server-only': new URL('./test/helpers/server-only.ts', import.meta.url).pathname,
    },
  },
})
