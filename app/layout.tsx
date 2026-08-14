import type { Metadata } from 'next'

import { SiteHeader } from '@/components/SiteHeader'

import './globals.css'

export const metadata: Metadata = {
  title: 'FIUBA Classroom',
  description: 'Gestión de trabajos prácticos sobre repositorios de GitHub',
}

/** Port de app/views/layouts/application.html.erb */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Primer v22 defines every color token behind a [data-color-mode] selector.
    // Without these attributes none of them exist, `var(--borderColor-default)`
    // resolves to nothing, and the declarations using them are dropped — so
    // borders and text colors silently disappear.
    <html lang="es" data-color-mode="light" data-light-theme="light" data-dark-theme="dark">
      <body>
        <main className="color-bg-subtle" style={{ minHeight: '100vh' }}>
          <SiteHeader />
          <div className="container-lg p-responsive py-4">{children}</div>
        </main>
      </body>
    </html>
  )
}
