import 'server-only'

import { randomBytes } from 'node:crypto'

import { and, eq, isNull, ne } from 'drizzle-orm'

import { assignments, groupAssignments, organizations } from '@/db/schema'
import { db } from '@/lib/db'
import {
  findRepositoryByFullName,
  isRepositoryEmpty,
  REPOSITORY_FULL_NAME,
} from '@/lib/github/repositories'

/**
 * What an individual and a group assignment have in common: the title, the
 * slug that prefixes every repository, and the starter code.
 *
 * The original duplicates all of this between `Assignment` and
 * `GroupAssignment`, down to the identical validations. It shares only the
 * parts that touch GitHub, in `StarterCodeImportable` and in
 * `CreateGitHubRepoService::Exercise`; this module is the same idea taken one
 * step further, so that the two data layers differ only where the flows
 * actually differ.
 */

// validates :title, length: { maximum: 60 } / validates :slug, length: { maximum: 60 }
const TITLE_MAX_LENGTH = 60
const SLUG_MAX_LENGTH = 60

// validates :slug, format: { with: /\A[-a-zA-Z0-9_]*\z/ }
const SLUG_FORMAT = /^[-a-zA-Z0-9_]+$/

/**
 * GitHubClassroom::Blacklist::NAMES, from config/initializers/03_blacklist.rb.
 * They are reserved because they collide with the routes that hang off the
 * assignment path: `/classrooms/:slug/assignments/new` would be shadowed by an
 * assignment whose slug is "new".
 */
const RESERVED_NAMES = ['new', 'edit']

/** Which field the message belongs to, so the form can mark the input */
export type AssignmentField = 'title' | 'slug' | 'starterCode' | 'base'

export type FieldError<Field extends string = AssignmentField> = {
  error: string
  field: Field
}

/** The title and slug validations of both models, in the original's order */
export function validateTitleAndSlug(title: string, slug: string): FieldError | null {
  // validates :title, presence: true
  if (title.length === 0) {
    return { error: 'El título no puede estar vacío.', field: 'title' }
  }

  if (title.length > TITLE_MAX_LENGTH) {
    return {
      error: `El título no puede superar los ${TITLE_MAX_LENGTH} caracteres.`,
      field: 'title',
    }
  }

  // validates_not_reserved_word :title
  if (RESERVED_NAMES.includes(title.toLowerCase())) {
    return { error: `"${title}" es una palabra reservada.`, field: 'title' }
  }

  // validates :slug, presence: true
  if (slug.length === 0) {
    return { error: 'El prefijo no puede estar vacío.', field: 'slug' }
  }

  if (slug.length > SLUG_MAX_LENGTH) {
    return {
      error: `El prefijo no puede superar los ${SLUG_MAX_LENGTH} caracteres.`,
      field: 'slug',
    }
  }

  if (!SLUG_FORMAT.test(slug)) {
    return {
      error: 'El prefijo sólo puede tener letras, números, guiones y guiones bajos.',
      field: 'slug',
    }
  }

  // Divergence: the original only ran validates_not_reserved_word on the
  // title, even though `to_param` returns the slug and the slug is what ends
  // up in the URL. A title of "Trabajo Práctico" with the slug hand-edited to
  // "new" would have shadowed the new-assignment route. Checking both closes
  // that; the JS-derived slug means the title check almost always fires first.
  if (RESERVED_NAMES.includes(slug.toLowerCase())) {
    return { error: `"${slug}" es una palabra reservada.`, field: 'slug' }
  }

  return null
}

/** The classroom that already prefixes its repositories with a given slug */
export type SlugClash = { classroomId: number; classroomTitle: string }

/**
 * The assignment doing the asking, when it already exists.
 *
 * Rails got this for free: `validates :slug, uniqueness: { scope: }` excludes
 * the record being saved, and `uniqueness_of_slug_across_organization` ran
 * `Assignment.where(...)` on a scope that a persisted record is not compared
 * against. Here the query is written by hand, so the exclusion has to be too —
 * without it, saving an assignment without touching its prefix finds itself.
 */
export type SlugClashExclusion = { kind: 'individual' | 'group'; id: number }

/**
 * Whether any assignment already claims this repository prefix, anywhere in the
 * GitHub organization.
 *
 * Widens the original's `validate :uniqueness_of_slug_across_organization`,
 * which asks the same question of one classroom and of the other kind of
 * assignment:
 *
 *   return if Assignment.where(slug: slug, organization: organization).blank?
 *
 * Two things make that too narrow here. The slug is the prefix of a repository
 * name (`<slug>-<login>`, `<slug>-<team>`), repository names are unique per
 * GitHub organization, and one organization hosts a classroom per term — so
 * `tp1` in the 2026a classroom and `tp1` in the 2026b one fight over the same
 * repositories, and `Exercise#suffixed_repo_name` quietly resolves it by
 * handing somebody a `-1`. Scoping the check to the GitHub organization is
 * what the repository namespace actually is.
 *
 * Not an index: it spans two tables and every classroom of an organization.
 * The suffix loop in lib/data/repositories.ts stays as the last backstop.
 */
export async function findSlugClash(
  githubId: number,
  slug: string,
  exclude?: SlugClashExclusion,
): Promise<SlugClash | null> {
  const individual = await db
    .select({ classroomId: organizations.id, classroomTitle: organizations.title })
    .from(assignments)
    .innerJoin(
      organizations,
      and(eq(organizations.id, assignments.organizationId), isNull(organizations.deletedAt)),
    )
    .where(
      and(
        eq(organizations.githubId, githubId),
        eq(assignments.slug, slug),
        isNull(assignments.deletedAt),
        exclude?.kind === 'individual' ? ne(assignments.id, exclude.id) : undefined,
      ),
    )
    .limit(1)

  if (individual.length > 0) return individual[0]

  const group = await db
    .select({ classroomId: organizations.id, classroomTitle: organizations.title })
    .from(groupAssignments)
    .innerJoin(
      organizations,
      and(eq(organizations.id, groupAssignments.organizationId), isNull(organizations.deletedAt)),
    )
    .where(
      and(
        eq(organizations.githubId, githubId),
        eq(groupAssignments.slug, slug),
        isNull(groupAssignments.deletedAt),
        exclude?.kind === 'group' ? ne(groupAssignments.id, exclude.id) : undefined,
      ),
    )
    .limit(1)

  return group[0] ?? null
}

/** The message for a prefix already taken, which reads differently across classrooms */
export function slugClashMessage(slug: string, clash: SlugClash, classroomId: number): string {
  if (clash.classroomId === classroomId) {
    return `Ya existe un trabajo práctico con el prefijo "${slug}" en este classroom.`
  }

  return (
    `El prefijo "${slug}" ya lo usa el classroom "${clash.classroomTitle}", que comparte la ` +
    'organización de GitHub. Los repositorios chocarían: elegí otro, por ejemplo agregándole el cuatrimestre.'
  )
}

/**
 * Port of the StarterCode controller concern plus the two validations of
 * StarterCodeImportable, which the original ran in different places.
 *
 * The original had a second path: the autocomplete posted a `repo_id` next to
 * the typed name, and `validate_starter_code_repository_id` trusted it after a
 * cheap existence check. There is no autocomplete here, so everything comes in
 * as `owner/name` and is resolved to an id the same way
 * `starter_code_repository_id` did.
 */
export async function resolveStarterCode(
  installationId: number,
  input: string,
): Promise<{ repositoryId: number | null; error?: FieldError }> {
  const fullName = input.trim()

  // Starter code is optional, exactly as in the original
  if (fullName.length === 0) return { repositoryId: null }

  const invalid = (error: string) => ({
    repositoryId: null,
    error: { error, field: 'starterCode' as const },
  })

  // StarterCode::WRONG_FORMAT
  if (!REPOSITORY_FULL_NAME.test(fullName)) {
    return invalid('Usá el formato owner/nombre, por ejemplo fiubaTA050-labs/raft-starter.')
  }

  const repository = await findRepositoryByFullName(installationId, fullName)

  // StarterCode::INVALID_SELECTION. GitHub answers 404 both when the repo does
  // not exist and when it exists but the App cannot see it, and it does that on
  // purpose — so the message has to offer both readings. Measured: the
  // installation token reaches any repo in an org where the App is installed,
  // and any public repo anywhere; a private repo elsewhere is the blind spot.
  if (!repository) {
    return invalid(
      `No encontramos "${fullName}". Si es privado y está en otra organización, instalá ahí ` +
        'la App de FIUBA Classroom o hacé público el repositorio.',
    )
  }

  // validate :starter_code_repository_is_template. The original only enforced
  // this when template_repos_enabled; with the source importer gone it is the
  // only way to copy starter code, so it always applies.
  if (!repository.isTemplate) {
    return invalid(
      `"${repository.fullName}" no es un template repository. Activá "Template repository" ` +
        'en Settings del repo para poder clonarlo a cada alumno.',
    )
  }

  // validate :starter_code_repository_not_empty
  if (await isRepositoryEmpty(installationId, repository.fullName)) {
    return invalid(
      `"${repository.fullName}" está vacío. Elegí un repo con contenido, o dejá el campo ` +
        'en blanco para crear el trabajo práctico sin starter code.',
    )
  }

  return { repositoryId: repository.id }
}

/** AssignmentInvitation#assign_key: `SecureRandom.hex(16)` */
export function invitationKey(): string {
  return randomBytes(16).toString('hex')
}

/**
 * The short key behind `/a/<key>` and `/g/<key>`. Port of the ShortKey
 * concern's `SecureRandom.urlsafe_base64(6)`: six random bytes, eight
 * url-safe base64 characters.
 *
 * The original follows it with `.sub("+", "=")`, which never fires —
 * `urlsafe_base64` emits `-` and `_`, never `+` — so it is not ported.
 *
 * Eight characters of base64 is 48 bits, and the unique index is what actually
 * enforces it. No retry on collision: at a birthday bound of N²/2⁴⁹ even ten
 * thousand invitations sit under one in five million, and the transaction
 * already rolls back and reports on a unique violation.
 */
export function invitationShortKey(): string {
  return randomBytes(6).toString('base64url')
}
