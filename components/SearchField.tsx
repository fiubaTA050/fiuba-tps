'use client'

import { SearchIcon, XCircleFillIcon } from '@primer/octicons-react'

/**
 * The FormControl search field from the live filter bars — Primer's leading
 * icon + trailing clear button, extracted here because the roster page needs
 * it twice, once per tab. Markup ported verbatim from
 * `AssignmentRepoList.tsx`, which keeps its own copy inline.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
}) {
  return (
    <div className="FormControl-input-wrap FormControl-input-wrap--leadingVisual FormControl-input-wrap--trailingAction">
      <span className="FormControl-input-leadingVisualWrap">
        <SearchIcon className="FormControl-input-leadingVisual" />
      </span>

      <input
        type="text"
        className="form-control width-full"
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />

      {/* Always rendered, as on the live site, which shows it on an empty
          field too */}
      <button
        type="button"
        className="FormControl-input-trailingAction"
        aria-label="Limpiar la búsqueda"
        onClick={() => onChange('')}
      >
        <XCircleFillIcon />
      </button>
    </div>
  )
}
