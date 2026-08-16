/**
 * The row of counters the live assignment dashboard puts under its header,
 * between the title band and the list of repositories.
 *
 * The live site shows four: Students total, Accepted assignments, Assignment
 * submissions and **Passed students**. The fourth counts autograding results
 * and there is no autograding here, so it is dropped and its `.Progress` bar
 * moves onto the submissions tile — the one number on this page that is a
 * fraction of a whole worth seeing at a glance.
 *
 * Markup from the capture: a `clearfix gutter-condensed` row of `Box`es, the
 * label as `h5` with a `Counter`, and the parts as `h3` numbers with a muted
 * caption.
 */
export type StatTile = {
  label: string
  total: number
  /** The breakdown under the total; one or two of them, as the live site does */
  parts: { value: number; label: string }[]
  /**
   * 0..1. Renders the bar of the live "Passed students" tile. Leave it out
   * when the whole is zero — a bar that is 100% "missing" reads as a failure
   * where there is simply nothing yet.
   */
  progress?: number
}

export function StatTiles({ tiles }: { tiles: StatTile[] }) {
  // The live site hardcodes col-md-3 for its four tiles
  const column = tiles.length >= 4 ? 'col-md-3' : tiles.length === 3 ? 'col-md-4' : 'col-md-6'

  return (
    <div className="clearfix gutter-condensed pb-3 mb-3">
      {tiles.map((tile) => (
        <div key={tile.label} className={`${column} float-left col-sm-12 mb-3 mb-md-0`}>
          <div className="Box">
            <div className="Box-body">
              <p className="h5">
                {tile.label}
                <span className="ml-1">
                  <span title={String(tile.total)} className="Counter">
                    {tile.total}
                  </span>
                </span>
              </p>

              <div className="clearfix d-flex">
                {tile.parts.map((part) => (
                  <div
                    key={part.label}
                    className={`${tile.parts.length === 1 ? 'col-12' : 'col-6'} float-left`}
                  >
                    <span className="h3 mr-1">{part.value}</span>
                    <span className="color-fg-muted">{part.label}</span>
                  </div>
                ))}
              </div>

              {/* The live site squeezes this beside the numbers, which only
                  fits its single-part "Passed students" tile */}
              {tile.progress !== undefined && (
                <span className="Progress Progress--small mt-2">
                  <span
                    className="Progress-item color-bg-success-emphasis"
                    style={{ width: `${Math.round(tile.progress * 100)}%` }}
                  />
                  <span
                    className="Progress-item color-bg-danger-emphasis"
                    style={{ width: `${100 - Math.round(tile.progress * 100)}%` }}
                  />
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
