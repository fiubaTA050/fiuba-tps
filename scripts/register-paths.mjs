import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Teaches `node` the `@/` alias of tsconfig.json, so a script can import the
 * app's own modules instead of a second copy of them.
 *
 * Node runs TypeScript on its own since 22 (type stripping, no flag since
 * 23.6) but resolves modules by URL and knows nothing about tsconfig `paths`,
 * so `@/lib/data/import` reaches nothing. The hook maps the prefix to the repo
 * root and adds the extension the bundler would have added.
 *
 * The other half of running these modules under plain node is
 * `--conditions=react-server`: the data layer imports `server-only`, whose
 * default export throws on purpose, and that condition is the one Next sets to
 * resolve it to the empty module. See the `import:classroom` script.
 */
const root = pathToFileURL(`${join(dirname(fileURLToPath(import.meta.url)), '..')}/`)

registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith('@/')) return next(specifier, context)

    const base = new URL(specifier.slice(2), root)
    for (const candidate of [base.href, `${base.href}.ts`, `${base.href}/index.ts`]) {
      if (existsSync(new URL(candidate))) return next(candidate, context)
    }

    return next(base.href, context)
  },
})
