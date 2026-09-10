'use client'

import { CheckIcon, DotFillIcon, TriangleDownIcon } from '@primer/octicons-react'

/**
 * One of the live site's `action-menu`s: an `Overlay` holding an `ActionList`
 * of `menuitemcheckbox` items, each a checkmark column that only shows when
 * the item is on, an optional coloured dot, the label, and an optional
 * description under it.
 *
 * The markup is the live site's, the behaviour is a plain `<details>`: its
 * `action-menu` is a `@primer/view-components` web component, and the port
 * depends on none of that package (see the CSS note in app/globals.css).
 *
 * Extracted from `AssignmentRepoList.tsx`, which first ported it, because the
 * roster page's filter bar needs the same dropdown.
 */
export function CheckboxMenu<T extends string>({
  label,
  heading,
  options,
  selected,
  onToggle,
  grouped = false,
  alignRight = false,
}: {
  label: string
  heading: string
  options: { value: T; label: string; description?: string; dot?: string }[]
  selected: Set<T>
  onToggle: (value: T) => void
  /** Sits inside the BtnGroup, joined to the search field on its right */
  grouped?: boolean
  alignRight?: boolean
}) {
  return (
    <details
      className={`dropdown details-reset details-overlay ${
        grouped ? 'BtnGroup-parent' : 'd-inline-block mr-2 mb-2 mb-lg-0'
      }`}
    >
      <summary
        className={`btn ${grouped ? 'BtnGroup-item' : ''}`}
        role="button"
        aria-haspopup="menu"
      >
        {label}
        {selected.size > 0 && <span className="Counter ml-1">{selected.size}</span>}
        <TriangleDownIcon className="ml-1" />
      </summary>

      <div className={`ActionMenu-anchor ${alignRight ? 'ActionMenu-anchor--right' : ''}`}>
        <div className="Overlay Overlay--size-auto">
          <div className="Overlay-body Overlay-body--paddingNone">
            <ul role="menu" className="ActionListWrap ActionListWrap--inset">
              <li className="ActionList-sectionDivider" role="presentation">
                <div className="ActionList-sectionDivider-title">{heading}</div>
              </li>

              {options.map((option) => (
                <li key={option.value} role="none" className="ActionListItem">
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={selected.has(option.value)}
                    onClick={() => onToggle(option.value)}
                    className={`ActionListContent ActionListContent--visual16 ${
                      option.description ? 'ActionListContent--blockDescription' : ''
                    }`}
                  >
                    <span className="ActionListItem-visual ActionListItem-action--leading">
                      <CheckIcon className="ActionListItem-singleSelectCheckmark" />
                    </span>

                    {option.dot && (
                      <span className="ActionListItem-visual ActionListItem-visual--leading">
                        {/* The colour goes on a wrapper, not the octicon:
                            `.ActionListItem-visual` sets `fill` to the muted
                            foreground, which an svg inherits over its own
                            currentColor */}
                        <span style={{ color: option.dot, fill: option.dot }}>
                          <DotFillIcon size={24} />
                        </span>
                      </span>
                    )}

                    {option.description ? (
                      <span className="ActionListItem-descriptionWrap">
                        <span className="ActionListItem-label">{option.label}</span>
                        <span className="ActionListItem-description">{option.description}</span>
                      </span>
                    ) : (
                      <span className="ActionListItem-label">{option.label}</span>
                    )}
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
