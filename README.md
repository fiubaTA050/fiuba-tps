# FIUBA Classroom

Port de [GitHub Classroom](https://github.com/github-education-resources/classroom) (Rails, MIT)
a Next.js sobre Vercel, para la cátedra TA050. GitHub Classroom se retira el 28/08/2026.

Estado: implementado el flujo de **crear un classroom**. El resto del port
(assignments, rosters, invitaciones) todavía no.

## El flujo implementado

1. Entrar y **iniciar sesión con GitHub** — `app/page.tsx`
2. **Nuevo classroom** — `app/classrooms/page.tsx`
3. **Elegir la organización** de la lista, o **Instalar en otra organización** →
   GitHub → volver — `app/classrooms/new/`, `app/github/setup/route.ts`
4. **Escribir el nombre** del classroom
5. **Crear classroom** → redirige a `/classrooms/<slug>`

## Correspondencia con el original

| Este repo | Original |
|---|---|
| `db/schema.ts` | `db/schema.rb` |
| `lib/data/organizations.ts` → `createClassroom` | `app/models/organization/creator.rb` |
| `lib/data/organizations.ts` → `listClassrooms` | `organizations_controller.rb#index` |
| `lib/data/slug.ts` | `app/models/concerns/sluggable.rb` |
| `lib/github/organizations.ts` → `isOrganizationAdmin` | `github_organization.rb#admin?` |
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
- La lista de orgs del paso 3 sale de `GET /user/installations`, así que sólo
  muestra orgs donde la App ya está instalada.

## Setup

### 1. La GitHub App

Se crea en una **cuenta u organización aparte** (p. ej. `fiuba-classroom`), no
dentro de la org de la materia: una App privada sólo puede instalarse donde vive.
Marcala como **pública**.

- **Callback URL:** `https://<host>/api/auth/callback/github`
- **Setup URL:** `https://<host>/github/setup`, con *Redirect on update* activado
- **Request user authorization (OAuth) during installation:** activado
- **Webhook:** se puede desactivar por ahora

Permisos:

| Ámbito | Permiso | Para qué |
|---|---|---|
| Repository → Administration | write | crear repos (todavía no se usa) |
| Repository → Contents | read & write | idem |
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

### 3. Correr

```bash
cp .env.example .env.local   # completar
npm install
npm run dev
```

## Tests

```bash
npm test
```

`test/creator.test.ts` es el port de `spec/models/organization/creator_spec.rb`.
Corre contra un Postgres real embebido (PGlite) al que se le aplica la
migración generada, así los índices únicos parciales y el rollback de la
transacción se ejercitan de verdad en vez de contra un mock.

Specs reutilizados del original:

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

- Assignments desde repo template, rosters, invitaciones (Inngest)
- **Antes del 28/08/2026:** correr el Classroom Export Utility sobre
  `fiubaTA050-labs`. Ese export no se puede regenerar después.
