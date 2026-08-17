/**
 * The row of counters the live assignment dashboard puts under its header,
 * between the title band and the list of repositories. Markup from a saved
 * copy of that page: a `clearfix gutter-condensed` row of `Box`es, the label as
 * an `h5` with a `Counter`, and the numbers as `h3` inside `col-6 float-left`
 * halves.
 *
 * The live site shows four tiles and this shows the first three, which the
 * docs define as: **Rostered students**, "the number of students on the
 * classroom's roster"; **Added students**, "the number of GitHub accounts that
 * have accepted the assignment and are not associated with a roster
 * identifier"; **Accepted students**, "the number of accounts that have
 * accepted this assignment"; and **Assignment submissions**, "the number of
 * students that have submitted the assignment". The fourth, **Passing
 * students**, counts autograding results and is dropped along with the
 * `.Progress` bar that only it carried — which is also why every tile here is
 * the same two-number shape, and so the same height.
 */
export type StatTile = {
  label: string
  total: number
  /** One or two halves, as on the live site */
  parts: { value: number; label: string }[]
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
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
