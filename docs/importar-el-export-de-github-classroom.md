# Importar un export de GitHub Classroom

GitHub Classroom cierra el 2026-08-28 y `classroom-export-utility` es lo único
que deja llevarse los datos. Este documento registra qué trae ese export, qué
no, y por qué el importador decide lo que decide.

```
npm run import:classroom -- <directorio> --teacher <login> [--teacher <login>]
npm run import:classroom -- <directorio> --dry-run     # no toca ni GitHub ni la base
```

- `--dry-run` lee, planifica e imprime. No necesita credenciales de nada, así
  que también sirve para mirar un export ajeno.
- `--classroom <id>` importa uno solo (el id del directorio `classroom-<id>`).
- `--installation <id>` evita preguntarle a GitHub cuál es la instalación de la
  App; con más de una organización, `<org_github_id>=<installation_id>`.
- `--grouping <título>` nombra el conjunto de equipos. Por defecto, "Equipos".

El script corre con el `node` del sistema, no con Next: `scripts/register-paths.mjs`
le enseña el alias `@/` de tsconfig, y `--conditions=react-server` resuelve
`server-only` al módulo vacío, que es lo que hace Next. Las dos cosas están en
el script de npm.

## Qué es el export

Un volcado 1:1 de la API pública de Classroom, un archivo por endpoint:

| Archivo | Endpoint |
|---|---|
| `classrooms.json` | `GET /classrooms` |
| `classroom-<id>/classroom.json` | `GET /classrooms/:id` |
| `classroom-<id>/assignments.json` | `GET /classrooms/:id/assignments` |
| `.../assignment-<id>/assignment.json` | `GET /assignments/:id` |
| `.../assignment-<id>/accepted-assignments.json` | `GET /assignments/:id/accepted_assignments` |
| `.../assignment-<id>/grades.csv` | `GET /assignments/:id/grades` |

El techo de lo importable es el de esa API, no el de la herramienta. Lo que
falta abajo, falta porque no hay endpoint que lo diga.

## Lo que no está en el export

1. **`organizations.installation_id`.** No es un concepto de Classroom. El
   script lo resuelve con `GET /orgs/:login/installation` de nuestra App, o lo
   toma de `--installation`.
2. **Los docentes (`organizations_users`).** Ningún endpoint los expone, y sin
   una fila ahí el classroom no lo ve nadie: es la frontera de autorización de
   `lib/data/`. Por eso `--teacher` es obligatorio, y el primero queda como
   `creator_id` de cada assignment.
3. **`users.uid`.** La trampa del formato: `students[].id` es el id **de
   Classroom**, no el de GitHub — para @espinaemmanuel el export dice 3268030 y
   GitHub dice 517713. El id real sólo aparece dentro de `avatar_url`
   (`/u/<uid>`), que es de donde lo saca `githubUid`; si faltara, el script
   pregunta por el login. Un importador que tome `students[].id` corrompe la
   tabla entera en silencio.
4. **El roster.** No hay endpoint. El padrón sobrevive únicamente en la columna
   `roster_identifier` de los grades.csv, con la forma `109525\tURBANO, SOL
   GUADALUPE` — padrón, tab, nombre. El tab pasa a espacio y el resto se guarda
   tal cual, porque el nombre es lo que un docente reconoce en la tabla. Dos
   consecuencias, ambas reportadas al correr: quien nunca aceptó nada no está en
   el export, y quien aceptó sin padrón queda como usuario y fuera del roster.
5. **El nombre de los equipos.** `accepted-assignments.json` trae el repo y sus
   integrantes, pero el nombre está en `group_name`, en el CSV. Se cruzan por
   nombre de repositorio. Medido contra el export real de TA050,
   `parameterize(group_name)` reproduce exactamente el sufijo del repo; cuando
   no coincide manda el repo, que es el nombre que los alumnos ya ven.
6. **La `key` larga de la invitación.** Sólo se exporta el link corto
   (`https://classroom.github.com/a/Mccf8hyl`). La key se genera nueva y el
   `short_key` se conserva, que es lo que hace que un link ya repartido funcione
   contra nuestro host: `/a/<short_key>` sólo busca y redirige. Si ese short key
   ya estuviera tomado, se genera otro.

## Lo que se descarta a propósito

`deadline`, `points_awarded`/`points_available`/`passing` (autograding),
`editor`, `language` y `feedback_pull_requests_enabled`: no hay dónde
guardarlos, y las dos primeras cosas no están portadas. `commit_count` y
`submitted` se descartan por lo contrario: el dashboard los calcula en vivo
contra GitHub y neto del commit inicial, así que los números del export ni
siquiera son comparables (AGENTS.md, "Entregado").

## Decisiones del importador

- **Un `grouping` por classroom**, no uno por assignment grupal. Es lo que hace
  la cátedra — los equipos del primer TP se reusan en el segundo — y es para lo
  que existe la tabla. Verificado en el export real: 48 alumnos en los dos TPs
  grupales de 2026/1, ningún cambio de equipo.
- **Un alumno que cambió de equipo dentro del classroom es un error, no una
  advertencia.** `groups_users` es único por `(grouping_id, user_id)` y `groups`
  por `(organization_id, slug)`: las dos membresías no entran, y renombrar
  equipos para que entren sería inventar datos. El classroom se saltea entero.
- **`invite_statuses` sale de las aceptaciones**: `completed` para quien tiene
  repo, `accepted` para quien aceptó y se quedó sin él. Todo lo que el export
  conoce ya pasó la pantalla de setup.
- **No es idempotente.** Un classroom ya importado (mismo `github_id` y mismo
  título) se rechaza antes de abrir la transacción, en vez de intentar
  reconciliar filas que un docente pudo haber editado. Para reimportar, borrar
  primero.
- **Una transacción por classroom.** Un classroom a medio importar se queda con
  el título y el slug mostrando un cuatrimestre incompleto, que es peor que no
  haberlo importado.
- **El slug lo calcula `organizationSlug`, no el export.** Coincide con el de
  Classroom en el export real, pero tiene que ser el que generan nuestros
  propios writers o el próximo rename lo rompe. Si difiere, se avisa: cambia la
  URL que los docentes conocen.
- **Los repositorios no se tocan.** El import escribe ids; los repos siguen en
  GitHub como estaban, que es donde vive la evidencia de la corrección.

## Después de importar

El dashboard de cada assignment lee los commits en vivo, así que la primera
carga dice si los ids importados apuntan a repositorios que existen. Un repo
borrado en GitHub se muestra como inalcanzable, sin romper la fila —
`NullGitHubRepository`.

**Si antes del import vaciaste la base, cerrá sesión en la app antes de
abrirla.** No alcanza con que la sesión vieja "no ande": los ids de `users` se
reasignan. Pasó el 2026-08-20 importando TA050, con un `truncate ... restart
identity` previo: @eespina-fiuba era el `users.id` 1, después del import ese id
quedó para otra persona, y el JWT de la sesión vieja — que guarda `userId`, no
el uid de GitHub (`auth.ts`) — siguió diciendo 1. Bastó abrir `/classrooms`
para que `linkUserToExistingClassrooms` le diera acceso de docente a los dos
classrooms **a la cuenta equivocada**, que ni siquiera es miembro de la
organización. Las filas se borran a mano de `organizations_users`; la sesión
hay que cerrarla primero o vuelven a aparecer solas.
