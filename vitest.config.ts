import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * The suite's configuration: build the migrated database once, before any
 * worker starts, and let every file restore from it. See
 * test/helpers/global-setup.ts for what that saves and why.
 *
 * The alias has to be spelled out here. With no config file at all Vitest was
 * picking `@/*` up from tsconfig.json; the moment this file exists it stops,
 * and every test fails on `Cannot find package '@/db/schema'`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // Everything under lib/data/ opens with `import 'server-only'`, which
      // resolves to a module that throws unless the `react-server` condition
      // is set. Next sets it; a bare Vitest run does not, and the failure is an
      // unhelpful "This module cannot be imported from a Client Component
      // module". Pointing at the package's own no-op is what that condition
      // would have selected anyway.
      // By path, not by specifier: its `exports` field only publishes ".", so
      // `server-only/empty.js` is refused.
      'server-only': fileURLToPath(
        new URL('./node_modules/server-only/empty.js', import.meta.url),
      ),
    },
  },
  test: {
    globalSetup: ['./test/helpers/global-setup.ts'],
  },
})
