import { NextResponse } from 'next/server'

const DEFAULT_TARGET = '/classrooms/new'

/**
 * Setup URL de la GitHub App: GitHub manda acá al docente después de instalar
 * o de cambiar la instalación. Es el "y volvés" del paso 3.
 *
 * No hay nada que persistir: la instalación es fuente de verdad y la
 * descubrimos con GET /user/installations cuando renderizamos la pantalla.
 * Esto es sólo el rebote.
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const state = requestUrl.searchParams.get('state')

  // `state` vuelve tal cual se lo mandamos a GitHub, así que se valida como
  // input externo. Se compara el origin ya resuelto en vez de matchear la
  // string: el parser de URL trata `\` como `/` en schemes especiales, así que
  // un `/\evil.com` pasa cualquier regex que sólo mire el prefijo y termina
  // resolviendo a https://evil.com.
  const target = state ? new URL(state, requestUrl) : null
  const safe = target?.origin === requestUrl.origin ? target : new URL(DEFAULT_TARGET, requestUrl)

  return NextResponse.redirect(safe)
}
