import { parameterize } from '@/lib/data/slug'

/**
 * The file a teacher downloads right after creating a key, so the worker can
 * be pointed at it instead of having the raw value pasted into a config by
 * hand. Split out of app/settings/api-keys/ApiKeyRow.tsx so it can be tested
 * without a DOM: the component only wires it to an `<a download>`.
 *
 * Everything here but `api_key` is readable on the keys page afterwards. The
 * label and the scopes travel along anyway, because a credential sitting on
 * the worker's disk has to say which one it is and what it can do.
 * `created_at` does not: the file carries its own mtime, which stays truthful
 * across a copy in a way a baked-in date would not.
 */
export type ApiKeyFile = {
  label: string
  api_url: string
  api_key: string
  scopes: string[]
}

export function apiKeyFileContents(
  apiKey: { label: string; scopes: string[] },
  rawKey: string,
  origin: string,
): string {
  const contents: ApiKeyFile = {
    label: apiKey.label,
    api_url: `${origin}/api`,
    api_key: rawKey,
    scopes: apiKey.scopes,
  }

  return JSON.stringify(contents, null, 2)
}

/** Distinct per key, so downloading two does not leave a `key.json (1)`. */
export function apiKeyFileName(apiKey: { id: number; label: string }): string {
  // a label of nothing but punctuation parameterizes to the empty string
  const name = parameterize(apiKey.label) || String(apiKey.id)

  return `fiuba-classroom-${name}.json`
}
