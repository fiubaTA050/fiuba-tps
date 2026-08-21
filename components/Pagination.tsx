'use client'

/**
 * The paginator of the original: `app/views/kaminari/_paginator.html.erb` and
 * its `_prev_page`, `_page`, `_gap` and `_next_page` partials, wrapped in
 * `shared/_pagination.html.erb`. The live classroom.github.com still renders
 * exactly this markup — a `.paginate-container` holding a `nav.pagination`
 * with Previous, a window of page numbers and Next — and Primer v22 still
 * ships the `.pagination` rules, so nothing has to be copied into globals.css
 * beyond the buttons (see below).
 *
 * Which numbers the window holds is Kaminari's default configuration: `window:
 * 4` around the current page and `outer_window: 0`, so the first and last
 * pages are not pinned and everything outside the window collapses into a
 * single gap, the way `page.was_truncated?` does it.
 *
 * Two divergences from that markup, both from paginating in the browser:
 *
 * - The page numbers are `<button>`s where the original renders links, so no
 *   navigation happens. `app/globals.css` repeats Primer's `.pagination a`
 *   rules for them.
 * - The `<h2 class="sr-only">` the live site puts *inside* the nav is an
 *   `aria-label` instead. As its first child that heading pushes Previous into
 *   `:nth-child(2)`, which Primer hides under 544px — on the live site the
 *   narrow paginator has no Previous at all.
 */
export function Pagination({
  page,
  pageCount,
  onChange,
  label,
}: {
  /** 1-based */
  page: number
  pageCount: number
  onChange: (page: number) => void
  /** Names the nav for a screen reader, when a screen holds more than one */
  label?: string
}) {
  // `shared/_pagination` renders nothing without a previous or a next page
  if (pageCount <= 1) return null

  const items: (number | 'gap')[] = []
  for (let number = 1; number <= pageCount; number++) {
    if (Math.abs(number - page) <= 4) items.push(number)
    else if (items[items.length - 1] !== 'gap') items.push('gap')
  }

  return (
    <div className="paginate-container width-full">
      <nav className="pagination" aria-label={label ?? 'Paginación'}>
        {page === 1 ? (
          <span className="prev disabled">Anterior</span>
        ) : (
          <button type="button" className="prev" onClick={() => onChange(page - 1)}>
            Anterior
          </button>
        )}

        {items.map((item, index) =>
          item === 'gap' ? (
            <span key={`gap-${index}`} className="page gap">
              …
            </span>
          ) : item === page ? (
            <em key={item} className="current" aria-current="page">
              {item}
            </em>
          ) : (
            <button
              key={item}
              type="button"
              aria-label={`Página ${item}`}
              onClick={() => onChange(item)}
            >
              {item}
            </button>
          ),
        )}

        {page === pageCount ? (
          <span className="next disabled">Siguiente</span>
        ) : (
          <button type="button" className="next" onClick={() => onChange(page + 1)}>
            Siguiente
          </button>
        )}
      </nav>
    </div>
  )
}
