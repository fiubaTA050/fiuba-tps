/**
 * Environment variable access with lazy validation.
 *
 * The getters defer validation to the moment of use: `next build` does not
 * need real credentials, but a request that does need them fails with a clear
 * message instead of an `undefined` that propagates.
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Ver .env.example`)
  }
  return value
}

export const env = {
  /** Supabase pooler, port 6543. See lib/db.ts */
  get databaseUrl() {
    return required('DATABASE_URL')
  },

  /** Numeric. Shown on the GitHub App's settings page */
  get githubAppId() {
    return required('GITHUB_APP_ID')
  },

  /**
   * The App's slug exactly as it appears in its public URL
   * (github.com/apps/<slug>). Used to build the installation link.
   */
  get githubAppSlug() {
    return required('GITHUB_APP_SLUG')
  },

  /**
   * The private key PEM. On Vercel you paste the whole contents of the .pem;
   * if the value arrives with literal `\n` (typical of a single-line .env)
   * they are normalized into real newlines.
   */
  get githubAppPrivateKey() {
    return required('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n')
  },

  /** Client ID/secret *of the GitHub App*, not of a separate OAuth App. See README */
  get githubClientId() {
    return required('GITHUB_CLIENT_ID')
  },

  get githubClientSecret() {
    return required('GITHUB_CLIENT_SECRET')
  },
}
