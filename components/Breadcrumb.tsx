import Link from 'next/link'

/**
 * The bar every classroom screen starts with, ported from the live
 * classroom.github.com:
 *
 *   <div class="p-3 border-bottom">
 *     <nav aria-label="Breadcrumb"><ol>
 *       <li class="breadcrumb-item"><a class="Link">Classrooms</a></li>
 *       <li class="breadcrumb-item breadcrumb-item-selected"><a aria-current="page" …>
 *
 * The last item is the current page: it keeps its href, like the original's,
 * and `.breadcrumb-item-selected` is what stops it from looking clickable.
 */
export function Breadcrumb({ items }: { items: { label: string; href: string }[] }) {
  return (
    <div className="p-3 border-bottom">
      <nav aria-label="Breadcrumb">
        <ol>
          {items.map((item, index) => {
            const current = index === items.length - 1

            return (
              <li
                key={item.href}
                className={`breadcrumb-item Truncate ${current ? 'breadcrumb-item-selected' : ''}`}
              >
                <Link href={item.href} className="Link" aria-current={current ? 'page' : undefined}>
                  {item.label}
                </Link>
              </li>
            )
          })}
        </ol>
      </nav>
    </div>
  )
}
