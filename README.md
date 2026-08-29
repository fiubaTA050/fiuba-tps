# FIUBA Classroom

Port de [GitHub Classroom](https://github.com/github-education-resources/classroom) (Rails, MIT)
a Next.js sobre Vercel, para la cátedra TA050. GitHub Classroom se retira el 28/08/2026.

Estado: portados el flujo del docente y el del alumno de punta a punta. Los
repos de los alumnos se crean contra GitHub de verdad.

## Lo que hay

**Docente**

1. **Iniciar sesión con GitHub** — `app/page.tsx`
2. **Crear un classroom**: elegir la organización, o instalar la App en otra →
   GitHub → volver — `app/classrooms/new/`, `app/github/setup/route.ts`
3. **Listado de classrooms** en grilla de tarjetas, con archivado —
   `app/classrooms/page.tsx`
4. **Assignments individuales y grupales**, con starter code y autocomplete de
   repos — `app/classrooms/[slug]/assignments/`, `.../group-assignments/`
5. **Editar y borrar** un assignment — ver `docs/edicion-y-borrado-de-assignments.md`
6. **Roster** de alumnos por padrón, con vinculación de las cuentas de GitHub
   sueltas — `app/classrooms/[slug]/roster/`
7. **Equipos** de un assignment grupal — `app/classrooms/[slug]/groupings/`
8. **Dashboard** de cada assignment: repositorio, último commit y cantidad de
   commits por alumno o equipo, con filtros y orden —
   `app/classrooms/[slug]/assignments/[assignmentSlug]/`

**Alumno**

1. Abre el **link de invitación**, corto (`/a/<key>`, `/g/<key>`) o largo
2. Se **vincula con su padrón** del roster
3. Acepta y **su repositorio se crea dentro de ese mismo request**, sin cola —
   ver `docs/creacion-de-repos.md`

## Correspondencia con el original

| Este repo | Original |
|---|---|
| `db/schema.ts` | `db/schema.rb` |
| `lib/data/organizations.ts` → `createClassroom` | `app/models/organization/creator.rb` |
| `lib/data/organizations.ts` → `listClassrooms` | `organizations_controller.rb#index` |
| `lib/data/slug.ts` | `app/models/concerns/sluggable.rb` |
| `lib/github/organizations.ts` → `isOrganizationAdmin` | `github_organization.rb#admin?` |
| `lib/data/assignments.ts` | `assignments_controller.rb` |
| `lib/data/group-assignments.ts` | `group_assignments_controller.rb` |
| `lib/data/rosters.ts` | `rosters_controller.rb` |
| `lib/data/invitations.ts` | `assignment_invitations_controller.rb` + `InvitationsControllerMethods` |
| `lib/data/group-invitations.ts` | `group_assignment_invitations_controller.rb` |
| `lib/data/groups.ts` | `groups_controller.rb` + `grouping.rb` |
| `app/a/[shortKey]/`, `app/g/[shortKey]/` | `short_url_controller.rb` + `routes.rb:31-32` |
| `app/classrooms/new/NewClassroomForm.tsx` | `views/organizations/new.html.erb` + `setup.html.erb` |
| `components/SiteHeader.tsx` | `views/shared/_header.html.erb` |

Se mantienen los nombres del original: la tabla `organizations` es el classroom,
no la organización de GitHub. Las URLs también coinciden (`/classrooms`,
`/classrooms/new`, `/classrooms/:slug`), igual que en
`resources :organizations, path: "classrooms"`.

### Divergencias deliberadas

- **GitHub App en vez de OAuth App.** El original guardaba el token OAuth de
  cada docente (`users.token`) y lo usaba para operar sobre la org. Acá esa
  columna no existe: lo privilegiado va con installation token, que se genera
  on-demand y expira en 1 h.
- **`organizations.installation_id` reemplaza a `organization_webhook_id`.**
  El tenant es la instalación de la App, no un webhook de org.
- **El nombre se pide antes de crear.** El original autogeneraba
  `<org>-classroom-1` y lo dejaba cambiar en una pantalla de setup posterior.
- La lista de orgs sale de `GET /user/installations`, así que sólo muestra orgs
  donde la App ya está instalada.
- **Sólo las orgs habilitadas pueden crear classrooms** (`GITHUB_ALLOWED_ORG_IDS`).
  El original no tenía nada parecido: era el servicio público de GitHub.

`AGENTS.md` lleva la lista completa y el porqué de cada una.

## Setup

### 1. La GitHub App

La App de este deploy es **FIUBA TPs** (slug `fiuba-tps`), la posee la
organización `fiubaTA050` y es **pública**. Pública no es opcional: una App
privada sólo puede instalarse en la cuenta que la posee, y ésta también tiene
que instalarse en `fiubaTA050-labs`, que es donde viven los repos de la materia.

- **Callback URL:** admite hasta 10. Están cargadas la de producción
  (`https://fiuba-tps.vercel.app/api/auth/callback/github`) y la de desarrollo
  (`http://localhost:3000/api/auth/callback/github`). El orden no importa,
  porque Auth.js manda `redirect_uri` explícito.
- **Setup URL:** `https://<host>/github/setup`, con *Redirect on update*
  activado. Es un **campo único**: producción y localhost no pueden convivir, y
  va el de producción, porque instalar la App es algo que los docentes hacen
  sobre el sitio real. Con la opción de abajo desactivada, este campo *es* el
  redirect posterior a la instalación — si apunta a localhost, instalar desde
  producción deja al docente en una página que no existe.
- **Request user authorization (OAuth) during installation:** **desactivado**, y
  tiene que quedar así. Con la opción activada, instalar manda al docente por el
  callback de OAuth sin la cookie de PKCE: Auth.js falla y cae en
  `/?error=Configuration`.
- **Webhook:** inactivo. Todavía no se consume ningún evento.

Permisos, tal como los tiene hoy:

| Ámbito | Permiso | Para qué |
|---|---|---|
| Repository → Administration | write | crear el repo del alumno y darle acceso |
| Repository → Contents | read & write | generarlo desde el starter code |
| Repository → Metadata | read | obligatorio |
| Organization → Members | read | `isOrganizationAdmin` |
| Organization → Administration | **write** | `setDefaultRepositoryPermissionToNone` |

> El último es imprescindible para este flujo: al crear el classroom se pone el
> permiso de repositorio por defecto de la org en `none`, igual que el original,
> para que los alumnos no vean los repos de sus compañeros. Si falla, se revierte
> la creación.

Generá una private key y guardá el `.pem`.

### 2. Base de datos

Creá el proyecto en Supabase, copiá las dos connection strings a `.env.local` y:

```bash
npm run db:migrate
```

#### Una base local, para no desarrollar contra la de la cátedra

`docker-compose.yml` levanta un Postgres 17 en el puerto **54322**:

```bash
docker compose up -d

export LOCAL_DB=postgresql://postgres:postgres@127.0.0.1:54322/fiuba_tps
DATABASE_URL=$LOCAL_DB DIRECT_URL=$LOCAL_DB npm run db:migrate
DATABASE_URL=$LOCAL_DB npm run dev
```

Pasar `DATABASE_URL` en la línea de comando le gana a `.env.local`, así que
apuntar a producción es siempre un acto deliberado y no lo que haya quedado de
la última edición. Los tests no usan esto: corren PGlite en proceso
(`test/helpers/db.ts`).

Las llamadas a GitHub siguen siendo reales aunque la base sea local — el token
de instalación no tiene un modo local. Para probar el flujo del alumno de punta
a punta conviene crear un repositorio descartable en la org y borrarlo después,
en vez de apuntarle al de un alumno: la pantalla de setup llama a
`addCollaborator` sobre el repo que encuentra.

### 3. Correr

```bash
cp .env.example .env.local   # completar
npm install
npm run dev
```

`GITHUB_ALLOWED_ORG_IDS` es la lista de orgs habilitadas para crear classrooms,
por id numérico y separadas por coma. Es obligatoria: sin ella no se puede
crear ninguno. El id se saca con `gh api /orgs/<login> --jq .id`. En Vercel va
en las env vars del proyecto, y cambiarla **requiere redeploy** para que tome
efecto. Los classrooms ya creados no se ven afectados: el chequeo está sólo en
la creación.

## Tests

```bash
npm test
```

15 archivos, 330 casos. Corren contra un Postgres real embebido (PGlite) al que
se le aplica la migración generada, así los índices únicos parciales y el
rollback de las transacciones se ejercitan de verdad en vez de contra un mock.
`test/creator.test.ts` es el port de `spec/models/organization/creator_spec.rb`.

Algunos de los specs reutilizados del original:

| Test | Spec original |
|---|---|
| no admins → falla | `creator_spec.rb` "does not allow non admins to be added" |
| falla el permiso → no queda fila | `creator_spec.rb` "deletes the organization if the repository permissions cannot be set to none" |
| varios classrooms por org | `creator_spec.rb` "multiple classrooms on same organization" |
| formato del slug | `organization_spec.rb` "when title is changed / updates the slug" |
| `admin?` = role admin + state active | `github_organization_spec.rb` "#admin?" |

## Licencia

MIT. Es un derivado de `github-education-resources/classroom` (MIT, © 2015
GitHub Inc.), cuyo aviso de copyright se mantiene en `LICENSE` como exige la
licencia. El nombre y el logo de GitHub Classroom son marca registrada y no se
usan.

## Pendiente

- **CI**: no hay workflows; `npm test` y `npm run build` se corren a mano.
- **Bajar las llamadas a la API de GitHub** al renderizar el listado de
  classrooms, que hoy cuesta varias por organización.
- **Antes del 28/08/2026:** correr el Classroom Export Utility sobre
  `fiubaTA050-labs`. Ese export no se puede regenerar después.
