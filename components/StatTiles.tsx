/**
 * The row of counters the live assignment dashboard puts under its header,
 * between the title band and the list of repositories. Markup from a saved
 * copy of that page: a `clearfix gutter-condensed` row of `Box`es, the label as
 * an `h5` with a `Counter`, and the numbers as `h3` inside `col-6 float-left`
 * halves.
 *
 * The live site shows four tiles, which the docs define as: **Rostered
 * students**, "the number of students on the classroom's roster"; **Added
 * students**, "the number of GitHub accounts that have accepted the assignment
 * and are not associated with a roster identifier"; **Accepted students**, "the
 * number of accounts that have accepted this assignment"; **Assignment
 * submissions**, "the number of students that have submitted the assignment";
 * and **Passed students**, which counts autograding results. The first three
 * are two numbers side by side; the fourth is a green `passed/total` next to a
 * `.Progress` bar, which is the `progress` shape below.
 *
 * One divergence in that bar: the live one paints everyone who did not pass
 * red, which works where grading runs on every push. Here it runs only once an
 * entrega closes, so that would read as the whole cohort failing for as long
 * as it is open; red is only an actual failed run, and the ungraded rest is
 * left on the bar's grey track.
 */
export type StatTile =
  | {
      label: string
      total: number
      /** One or two halves, as on the live site */
      parts: { value: number; label: string }[]
    }
  | {
      label: string
      /** The live "Passed students": `<green>3</green>/49 Passed` and a bar */
      progress: { value: number; failed: number; of: number; label: string }
    }

export function StatTiles({ tiles }: { tiles: StatTile[] }) {
  // The live site hardcodes col-md-3 for its four tiles
  const column = tiles.length >= 4 ? 'col-md-3' : tiles.length === 3 ? 'col-md-4' : 'col-md-6'

  return (
    <div className="clearfix gutter-condensed pb-3 mb-3">
      {tiles.map((tile, index) => (
        <div
          key={tile.label}
          className={`${column} float-left col-sm-12 ${
            index === tiles.length - 1 ? 'mt-sm-3 mt-md-0' : 'mb-sm-3 mb-md-0'
          }`}
        >
          <div className="Box">
            <div className="Box-body">
              <p className="h5">
                {tile.label}
                <span className="ml-1">
                  <span title={String(counter(tile))} className="Counter">
                    {counter(tile)}
                  </span>
                </span>
              </p>

              {'progress' in tile ? (
                <ProgressParts {...tile.progress} />
              ) : (
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
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** The live Counter of "Passed students" is the passed count, not the total */
function counter(tile: StatTile): number {
  return 'progress' in tile ? tile.progress.value : tile.total
}

function ProgressParts({
  value,
  failed,
  of,
  label,
}: {
  value: number
  failed: number
  of: number
  label: string
}) {
  // The live widths are floored — 3 of 49 renders as 6% and 93% — so the two
  // never add up past the bar
  const passed = of === 0 ? 0 : Math.floor((value / of) * 100)
  const rest = of === 0 ? 0 : Math.floor((failed / of) * 100)

  return (
    <div className="clearfix d-flex">
      <div className="col-6 float-left">
        <span className="h3 mr-1">
          <span className="color-fg-success">{value}</span>/{of}
        </span>
        <span className="color-fg-muted">{label}</span>
      </div>
      <div className="col-6 float-left flex-self-center mt-1">
        <span className="Progress Progress--small">
          <span style={{ width: `${passed}%` }} className="Progress-item color-bg-success-emphasis" />
          <span style={{ width: `${rest}%` }} className="Progress-item color-bg-danger-emphasis" />
        </span>
      </div>
    </div>
  )
}
