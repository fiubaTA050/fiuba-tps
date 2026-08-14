/**
 * Port of ActiveSupport::Inflector#parameterize, which is what the original's
 * `Sluggable` concern uses:
 *
 *   self.slug = name_for_slug.parameterize
 *
 * and for Organization, `name_for_slug` is `"#{github_id} #{title}"`.
 */
export function parameterize(value: string): string {
  return value
    .normalize('NFKD')
    // strip the diacritics left by the decomposition (the course is in Spanish)
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

/** Organization#name_for_slug */
export function organizationSlug(githubId: number, title: string): string {
  return parameterize(`${githubId} ${title}`)
}
