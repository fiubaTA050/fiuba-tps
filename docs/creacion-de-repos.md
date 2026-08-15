# Cómo se crea el repositorio de cada alumno, y cuándo habría que cambiarlo

Registro de la decisión tomada el 15/08/2026, con los números que la sostienen y
la condición que obligaría a revisarla. Si estás por meter una cola o un worker,
leé esto primero: puede que ya esté contestado, o puede que se haya cumplido la
condición y entonces adelante.

## La decisión

La creación del repositorio corre en **una ruta que dispara el navegador del
alumno**: `POST /assignment-invitations/[key]/create-repo`, que la pantalla de
setup llama al montarse. No hay cola, ni worker, ni cron, ni proveedor externo.

Es la forma del original. En GitHub Classroom, `accept` sólo deja la marca
(`invite_status.accepted!`) y quien arranca el trabajo es
`app/assets/javascripts/setup.js`, que en el callback `connected()` del
websocket hace `POST create_repo`. El botón "Retry repository setup" es ese
mismo POST otra vez. Lo único que cambia acá es que el trabajo ocurre en el
request en lugar de encolarse a Sidekiq.

Que lo dispare el navegador no es un detalle: **ese request trae el token de
sesión del alumno**, que es lo único que permite aceptar la invitación al repo
en su nombre. El original podía hacerlo desde un job porque guardaba
`users.token`; acá DA-6 lo prohíbe, así que el trabajo tiene que pasar por
algún request del alumno. Cualquier diseño futuro tiene que respetar eso o
resignarse a que a cada alumno le llegue un mail de GitHub para aceptar a mano.

## Los números

Medidos el 15/08/2026 contra `fiubaTA050-labs` y el template real de la
cátedra, tres corridas secuenciales (`spike-timing.mjs`, repos creados y
borrados):

| paso | min | max | prom |
|---|---|---|---|
| `POST /repos/:owner/:repo/generate` | 1864 ms | 2218 ms | **2046 ms** |
| que el repo tenga commits | 2988 ms | 3781 ms | 3353 ms |
| `PUT /repos/:owner/:repo/collaborators/:user` | 341 ms | 495 ms | **401 ms** |

Dos lecturas importantes:

- **El `generate` devuelve el repo vacío.** Durante ~3 s más, `GET /commits`
  responde 409. De ahí sale el `imported?` del original.
- **No hay que esperar ese contenido.** Con templates, el original tampoco
  espera: `use_importer?` es falso en ese camino y hace `completed!` apenas
  agrega al colaborador. Los 3,3 s no van en el request.

Así que el trabajo contra GitHub es `generate` + colaborador + aceptar
invitación ≈ **2,8 s**. Los primeros dos están medidos; aceptar la invitación
está estimado en ~0,4 s por analogía, porque no había una segunda cuenta de
GitHub con la cual probarlo (ver "Lo que falta confirmar").

### El request completo

Medido el mismo día contra la app corriendo, del `POST` a la respuesta:
**5,1 s**. La diferencia contra los 2,8 s son cosas del entorno de medición,
no de la ruta:

- `next dev` en lugar de un build de producción.
- La base está en `us-east-1` y la medición se hizo desde Buenos Aires: cada
  query son ~150-200 ms de ida y vuelta, y la ruta hace varias. En producción
  la función y Supabase están co-locadas en `iad1`.

La ruta declara `maxDuration = 60`. Incluso el número pesimista entra con
holgura, y entraría en el default de 10 s.

### Un token por instalación, no por llamada

La primera medición dio 5,9 s. La diferencia salió de que
`installationClient()` construía un `Octokit` nuevo en cada llamada, y cada
instancia mintea su propio installation token: cuatro llamadas a GitHub eran
cuatro `POST /app/installations/:id/access_tokens` de más. Ahora los clientes se
cachean por instalación a nivel de módulo, para que una instancia tibia reuse el
token entre requests. El token sigue sin escribirse en ningún lado, que es lo
que pide DA-6.

## Los límites de GitHub

De la doc oficial de *secondary rate limits*, verificada el 15/08/2026:

- No más de **100 requests concurrentes**.
- No más de **80 requests que crean contenido por minuto**, y no más de **500
  por hora**.
- No más de 900 puntos por minuto.
- Al pasarse: **403 o 429**, con `retry-after` cuando está presente. Si no está,
  esperar al menos un minuto.

El rate limit *core* no es el problema: la instalación tiene 12.500/hora y una
creación completa gasta ~4.

## La cuenta para TA050

Son ~100 alumnos. Cada uno cuesta ~2 requests que crean contenido (el `generate`
y la invitación de colaborador), o sea **~200 en total** contra un techo de 500
por hora. Holgado.

El único punto de roce es el minuto: si 40 alumnos entran en el mismo minuto
—un anuncio en clase y todos clickean— son 80 requests y estás justo en el
límite.

Por eso la ruta trata el 403/429 **como espera, no como error**: vuelve el
status a `accepted` y responde `retryAfter`, y el polling que ya está corriendo
reintenta cuando GitHub dijo. Los alumnos se auto-organizan en una cola sin que
exista una cola. El modo de falla es "esperá un minuto", no "no tenés repo".

Es más de lo que tuvo el original, que comía el `TooManyRequests` como error y
reintentaba tres veces a ciegas, acotado nada más que por tener cinco threads de
Sidekiq.

**Nota operativa:** publicar dos TPs a 100 alumnos dentro de la misma hora se
acerca a los 500/hora. No rompe —se auto-frena— pero conviene espaciarlos.

## Lo que dejó el Classroom original en esta misma organización

Vale la pena mirarlo antes de tocar nada, porque es la forma de falla contra la
que está diseñado el lock. En `fiubaTA050-labs`, al 15/08/2026:

- El assignment individual `2026a-tp2-raft` tiene **92 repositorios para 49
  alumnos**. 43 son sobrantes, con la escalera de sufijos de
  `Exercise#suffixed_repo_name`: `cgomez21` tiene 7, `Llaauuttyy` 6,
  `FedericoSolari` 6.
- En una muestra de 10, **8 no le dan acceso a su propio alumno**. Todos tienen
  un solo commit, el del template: nadie trabajó nunca en ellos.

No se puede reconstruir el mecanismo exacto —los logs no están y desde el código
hay varios caminos posibles—, pero la forma es inconfundible: trabajo que quedó
a medio hacer sin nadie que lo destrabara, y un alumno reintentando hasta que
algo saliera.

De ahí sale la expiración del lock. Si el request muere a mitad (timeout de la
función, un deploy, un crash) nunca llega al `catch`, y sin expiración el status
queda en `creating_repo` para siempre: el alumno mira una barra que no avanza y
ningún reintento puede tomar el lock. La pantalla muestra el botón de reintentar
pasado ese mismo tiempo, para que haya algo que apretar.

Los 67 miembros de la organización tampoco los puso el flujo individual: salen
de los **group assignments**, que crean un GitHub Team por grupo
(`RepoAccess` → `add_membership` + `accept_membership`), y estar en un team
implica ser miembro. Hay 21 teams con los nombres de los grupos. Para
individuales, ni el original ni este port agregan a nadie a la organización: el
alumno queda como outside collaborator del repo.

## Lo que falta confirmar

**Aceptar la invitación al repo con el token del alumno.** Es el único paso que
nunca se ejecutó contra GitHub. La verificación end-to-end se hizo con la cuenta
del docente, que como owner de la organización ya alcanza cualquier repo: GitHub
responde 204 sin crear invitación, así que `acceptRepositoryInvitation` no se
llama. Con una cuenta de alumno de verdad la respuesta es 201 con una
invitación, y ahí se ejercita.

Es el paso que decide si el alumno recibe un mail o no, así que **conviene
probarlo con una cuenta ajena antes del primer TP.** El resto del camino sí está
verificado contra GitHub real: repo creado desde el template con su commit
inicial, alumno como colaborador con permiso `push`, idempotente al recargar, y
el docente viéndolo como "Aceptó".

## Cuándo cambiar esto

La condición es **el techo de 500/hora**, no el de 80/minuto: el backoff absorbe
los picos de minuto, pero contra el techo de hora no hay backoff que alcance,
sólo esperar.

Concretamente, revisá este diseño si pasa alguna de estas:

- La cátedra pasa de ~200 alumnos, o el mismo classroom sirve a varias
  comisiones que publican juntas.
- Aparecen `invite_statuses` en `errored_creating_repo` de forma sostenida
  después de un TP. Es el síntoma medible, y queda registrado en la tabla sin
  que haya que instrumentar nada.
- Hace falta trabajo que el navegador del alumno no puede disparar: dar de baja
  repos al cerrar el cuatrimestre, sincronizar notas, cualquier cosa periódica.

## Qué hacer ese día

**Inngest** (o Trigger.dev, o QStash) es la salida razonable: `throttle` y
`concurrency` declarativos son exactamente lo que si no terminás escribiendo a
mano, y los reintentos con backoff por step ya vienen. Vercel Cron **no** es
opción mientras el proyecto esté en Hobby, donde está limitado a una corrida
diaria. `pg_cron` + `pg_net` en Supabase es la alternativa sin proveedor nuevo,
más incómoda de testear.

La migración está preparada. El código está cortado en dos piezas a propósito:

1. **`createStudentRepository(...)`** — sólo installation token, no sabe nada de
   sesiones. La puede llamar un request o un worker, le da igual. Se envuelve en
   un `step.run('crear-repo', ...)` sin tocarla.
2. **aceptar la invitación al repo** — sólo token del alumno, idempotente, corre
   cada vez que el alumno pasa por `/progress` y hay una invitación pendiente.

Mientras respetes ese corte, mudar de ejecutor es un archivo. Si los pegás como
los tiene el original dentro de `CreateGitHubRepoService#perform`, la migración
pasa a ser rehacer el servicio.

Y una regla si llega ese día: **`invite_statuses` sigue siendo la única fuente
de verdad de lo que ve el alumno.** El historial de runs del ejecutor es
contabilidad suya, no estado de la aplicación. Dos fuentes de verdad acá es
donde esto se rompe.
