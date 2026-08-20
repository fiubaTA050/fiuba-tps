'use client'

import {
  CheckIcon,
  KebabHorizontalIcon,
  PeopleIcon,
  PersonIcon,
  PlusIcon,
  SearchIcon,
  TriangleDownIcon,
  XCircleFillIcon,
} from '@primer/octicons-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'

import type { ClassroomCard } from '@/lib/data/organizations'

import { setArchivedAction } from './actions'

/**
 * The classroom index: the filter bar of `_organization_filters.html.erb` over
 * the card grid of `_organization_card_layout.html.erb`.
 *
 * Both partials are the original's, and the live classroom.github.com still
 * renders the same two — only the top band of a card changed. The original
 * painted it with a GeoPattern seeded on the classroom id (green when active,
 * grey when archived); the live site dropped GeoPattern for a flat band with
 * those two colours, and this follows it, so nothing here depends on a
 * pattern-generation library.
 *
 * **The filters run in the browser**, where both the original and the live
 * site put them in the URL (`organizations#search`, rendering `search.js.erb`).
 * Same reason as the assignment dashboard: this page is `force-dynamic` and
 * every render costs `GET /user/installations` plus one call per org, so a
 * filter in the URL would pay for GitHub on every keystroke. The teacher's
 * classrooms are all in the browser already — a cátedra has a handful, and the
 * original itself only paginated at 12.
 */

/** Organization.view_modes */
type View = 'all' | 'active' | 'archived'
/** Organization.sort_modes */
type Sort = 'newest' | 'oldest' | 'title'

const VIEW_LABEL: Record<View, string> = {
  all: 'Todos',
  active: 'Activos',
  archived: 'Archivados',
}

const SORT_LABEL: Record<Sort, string> = {
  newest: 'Más nuevos primero',
  oldest: 'Más viejos primero',
  title: 'Nombre del classroom',
}

export function ClassroomList({ classrooms }: { classrooms: ClassroomCard[] }) {
  const [query, setQuery] = useState('')
  // Divergence: the original defaults to "all" (`Organization.view_modes`);
  // a cátedra accumulates archived classrooms term after term and wants the
  // current ones first
  const [view, setView] = useState<View>('active')
  const [sort, setSort] = useState<Sort>('newest')

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()

    // scope :search_by_title — the original matches the title and nothing else
    const filtered = classrooms.filter((classroom) => {
      if (needle && !classroom.title.toLowerCase().includes(needle)) return false
      if (view === 'active') return classroom.archivedAt === null
      if (view === 'archived') return classroom.archivedAt !== null
      return true
    })

    // `listClassrooms` hands them over newest first, which is the default mode
    if (sort === 'oldest') return [...filtered].reverse()
    if (sort === 'title') {
      return [...filtered].sort((a, b) => a.title.localeCompare(b.title, 'es'))
    }
    return filtered
  }, [classrooms, query, view, sort])

  return (
    <>
      <div className="pt-3">
        <div role="search" className="d-flex flex-column flex-md-row">
          <div className="flex-1">
            <div className="FormControl-input-wrap FormControl-input-wrap--leadingVisual FormControl-input-wrap--trailingAction">
              <span className="FormControl-input-leadingVisualWrap">
                <SearchIcon className="FormControl-input-leadingVisual" />
              </span>

              <input
                type="text"
                className="form-control width-full"
                placeholder="Buscar un classroom"
                aria-label="Buscar un classroom por nombre"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />

              <button
                type="button"
                className="FormControl-input-trailingAction"
                aria-label="Limpiar la búsqueda"
                onClick={() => setQuery('')}
              >
                <XCircleFillIcon />
              </button>
            </div>
          </div>

          <div className="d-flex flex-self-end flex-sm-self-start mt-2 mt-md-0 flex-wrap">
            <RadioMenu
              label={`Ver: ${VIEW_LABEL[view]}`}
              heading="Ver:"
              options={VIEW_LABEL}
              selected={view}
              onSelect={setView}
            />

            <RadioMenu
              label={`Orden: ${SORT_LABEL[sort]}`}
              heading="Ordenar por:"
              options={SORT_LABEL}
              selected={sort}
              onSelect={setSort}
            />

            <Link href="/classrooms/new" className="btn btn-primary ml-2" role="button">
              <PlusIcon className="mr-2" />
              Nuevo classroom
            </Link>
          </div>
        </div>
      </div>

      <div className="my-4">
        {shown.length === 0 ? (
          <p className="color-fg-muted py-4">
            Ningún classroom coincide con la búsqueda.
          </p>
        ) : (
          <div className="d-sm-flex flex-wrap gutter-condensed">
            {shown.map((classroom) => (
              <ClassroomCardArticle key={classroom.id} classroom={classroom} />
            ))}

            {/* The last card of the grid, in the original and on the live site */}
            <article className="col-sm-12 col-md-6 mb-3 mb-sm-5">
              <Link
                href="/classrooms/new"
                aria-label="Crear un classroom nuevo"
                className="d-flex flex-column flex-justify-center flex-items-center rounded-1 height-full no-underline border p-5 color-fg-muted"
                role="button"
              >
                <PlusIcon size={40} />
              </Link>
            </article>
          </div>
        )}
      </div>
    </>
  )
}

function ClassroomCardArticle({ classroom }: { classroom: ClassroomCard }) {
  const archived = classroom.archivedAt !== null
  const path = `/classrooms/${classroom.slug}`

  return (
    <article className="col-sm-12 col-md-6 mb-3 mb-sm-5">
      <div className="color-bg-default rounded-1 height-full no-underline border color-shadow-small position-relative">
        <div className="position-relative py-2">
          <div
            className={`position-absolute top-0 right-0 bottom-0 left-0 ${
              archived ? 'color-bg-subtle' : 'color-bg-success-emphasis'
            }`}
          />
        </div>

        <details className="dropdown details-reset details-overlay d-inline-block float-right position-relative m-1">
          <summary
            className="btn-octicon m-0"
            aria-haspopup="menu"
            aria-label={`Opciones de ${classroom.title}`}
          >
            <KebabHorizontalIcon />
          </summary>

          {/* Anchored right, unlike the two menus of the filter bar: the kebab
              sits on the right edge of the card, which is where the original
              put its `dropdown-menu-sw` too */}
          <div className="ActionMenu-anchor ActionMenu-anchor--right">
            <div className="Overlay Overlay--size-auto">
              <div className="Overlay-body Overlay-body--paddingNone">
                <ul role="menu" className="ActionListWrap ActionListWrap--inset">
                  {/* The original hides it on an archived classroom instead of
                      disabling it, because the screen behind it refuses anyway */}
                  {!archived && (
                    <li role="none" className="ActionListItem">
                      <Link
                        href={`${path}/new-assignment`}
                        role="menuitem"
                        className="ActionListContent"
                      >
                        <span className="ActionListItem-label">Nuevo assignment</span>
                      </Link>
                    </li>
                  )}

                  <li role="none" className="ActionListItem">
                    <form action={setArchivedAction}>
                      <input type="hidden" name="slug" value={classroom.slug} />
                      <input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
                      <button type="submit" role="menuitem" className="ActionListContent">
                        <span className="ActionListItem-label">
                          {archived ? 'Desarchivar classroom' : 'Archivar classroom'}
                        </span>
                      </button>
                    </form>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </details>

        <Link href={path} className="d-block px-4 pt-2">
          <h2 className="h4 overflow-hidden no-wrap pt-1" style={{ textOverflow: 'ellipsis' }}>
            {classroom.title}
          </h2>
          {/* DA-2: the org login comes from GitHub, it is not stored */}
          <p className="f5 color-fg-muted mb-0">
            {classroom.organization ? (
              classroom.organization.login
            ) : (
              <span className="color-fg-attention">Organización inaccesible</span>
            )}
          </p>
        </Link>

        <div className="px-4 pb-3 pt-2">
          {classroom.assignments.length > 0 ? (
            <ul className="border-top py-2 list-style-none">
              {classroom.assignments.map((assignment) => (
                <li key={assignment.key} className="d-flex flex-items-center py-1">
                  {/* `d-inline-block text-center` on both, where the glyph
                      then rides the baseline; flex centres it in the circle */}
                  <span
                    className={`d-inline-flex flex-items-center flex-justify-center mr-2 circle flex-shrink-0 ${
                      assignment.group ? 'assignment-icon-group' : 'color-bg-accent'
                    }`}
                    style={{ width: 22, height: 22 }}
                  >
                    {assignment.group ? (
                      <PeopleIcon size={12} className="v-align-middle" />
                    ) : (
                      <PersonIcon size={12} className="v-align-middle" />
                    )}
                  </span>

                  <Link
                    href={`${path}/${assignment.group ? 'group-assignments' : 'assignments'}/${
                      assignment.slug
                    }`}
                    className="color-fg-default overflow-hidden no-wrap"
                    style={{ textOverflow: 'ellipsis' }}
                  >
                    {assignment.title}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            // The live site leaves this empty; the original's button stays,
            // because an empty classroom is one the teacher is still setting up
            <div className="py-4 border-top">
              {!archived && (
                <Link href={`${path}/new-assignment`} className="btn" role="button">
                  Crear el primer assignment
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

/**
 * The "View:" and "Sort by:" menus. Single select, so the live markup is the
 * `menuitemradio` ActionList the assignment dashboard already uses, over a
 * plain `<details>` — no popover, no web component.
 */
function RadioMenu<T extends string>({
  label,
  heading,
  options,
  selected,
  onSelect,
}: {
  label: string
  heading: string
  options: Record<T, string>
  selected: T
  onSelect: (value: T) => void
}) {
  return (
    <details className="dropdown details-reset details-overlay d-inline-block position-relative ml-2">
      <summary className="btn" role="button" aria-haspopup="menu">
        {label}
        <TriangleDownIcon className="ml-1" />
      </summary>

      {/* `align="start"` on the live `anchored-position`: the panel hangs from
          the left edge of its button, not from the right one */}
      <div className="ActionMenu-anchor">
        <div className="Overlay Overlay--size-auto">
          <div className="Overlay-body Overlay-body--paddingNone">
            <ul role="menu" className="ActionListWrap ActionListWrap--inset">
              <li className="ActionList-sectionDivider" role="presentation">
                <div className="ActionList-sectionDivider-title">{heading}</div>
              </li>

              {(Object.keys(options) as T[]).map((option) => (
                <li key={option} role="none" className="ActionListItem">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected === option}
                    className="ActionListContent"
                    onClick={(event) => {
                      onSelect(option)
                      event.currentTarget.closest('details')?.removeAttribute('open')
                    }}
                  >
                    <span className="ActionListItem-visual ActionListItem-action--leading">
                      <CheckIcon className="ActionListItem-singleSelectCheckmark" />
                    </span>
                    <span className="ActionListItem-label">{options[option]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </details>
  )
}
