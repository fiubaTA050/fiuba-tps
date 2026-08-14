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
    <html lang="es">
      <body>
        <main className="color-bg-subtle" style={{ minHeight: '100vh' }}>
          <SiteHeader />
          <div className="container-lg p-responsive py-4">{children}</div>
        </main>
      </body>
    </html>
  )
}
