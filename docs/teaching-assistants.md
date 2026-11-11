# Teaching assistants

Spec escrita el 11/11/2026, con las decisiones tomadas en la misma
conversación. Cubre cargar TAs en un classroom y asignarles, en cada trabajo
práctico, los alumnos o equipos que corrigen. **No** cubre darles acceso a los
repositorios en GitHub: eso es el trabajo siguiente y se apoya en lo que esta
spec deja en la base.

## Qué hacía el original

El código archivado **no tiene un rol de TA**. "TAs and Admins" es la tabla
`organizations_users`, que no tiene columna de rol: quien está ahí puede todo.

- **Entrar.** La condición es ser owner de la organización de GitHub:
  `GitHubOrganization#admin?` pide `membership.role == "admin" &&
  membership.state == "active"`. Cumplida, se entra solo, por dos caminos:
  - `Orgs::Controller#ensure_current_organization_visible_to_current_user`
    agrega al usuario cuando abre la URL del classroom, y responde 404 si no
    es owner.
  - `OrganizationsController#add_current_user_to_organizations` lo vincula a
    todos los classrooms de sus orgs cuando abre el índice.
- **Invitar.** La app no invita a nadie. `organizations/_invite_users.html.erb`
  dice "primero hacelo owner en `github.com/orgs/<org>/people`" y "después
  pasale el link del classroom".
- **Sacar.** `OrganizationsController#remove_user`, con tres reglas:
  - no se puede sacar al último (`Organization#one_owner_remains?`);
  - sus assignments pasan a otro docente (`TransferAssignmentsService`);
  - no se lo saca de la org. El modal lo avisa: *"this will not remove the
    user from the organization"*. Como sigue siendo owner, el índice lo
    vuelve a vincular en su próxima visita, así que el botón no sirve para
    nada duradero.

El sitio vivo es igual. La captura de "TAs and Admins" tiene la lista con
Remove y el panel "Invite admins", que repite "add them as owners" y "Ask them
to join this classroom URL". La documentación de GitHub lo dice sin vueltas:
*"Organization owners can administer any classroom for the organization."*

El port ya tiene la mitad del índice: `listClassrooms` →
`linkUserToExistingClassrooms`. No tiene la vinculación por URL directa
(`findClassroom` responde 404 si el usuario no está en la tabla), ni la
pestaña, ni la acción de sacar.

## Por qué nos apartamos

El trabajo siguiente es darle a cada TA acceso a los repositorios de *sus*
equipos. Un owner de la organización ya es admin de **todos** los
repositorios, así que con el modelo del original esa asignación no
restringiría nada. Por eso acá el TA es un rol de la app y no es miembro de la
organización.

## Decisiones

- **Profesor = owner de la org, como en el original.** Se mantiene la
  vinculación automática del índice. Los profesores se gestionan en GitHub y
  la app los muestra sin botón para sacarlos.
- **TA = rol propio de la app.** No es owner ni miembro de la organización.
  Si un TA pasa a ser owner, se convierte en profesor.
- **Carga por cuenta de GitHub, sin link.** El profesor escribe el login. La
  app lo resuelve a su id numérico y guarda el id (DA-2). No hay link de
  invitación: nadie se convierte en TA por tener una URL.
- **Por classroom.** Cada cuatrimestre se carga su equipo. Un TA del
  cuatrimestre anterior no ve el nuevo.
- **Solo los profesores** agregan y sacan TAs.
- **Lo que puede un TA:**
  - ver la lista de trabajos prácticos;
  - ver, dentro de cada trabajo práctico, solo las filas que tiene asignadas;
  - ver el detalle y el historial de entregas de esas filas;
  - escribir devoluciones sobre esas entregas.

  Nada más. No publica notas, no justifica ni extiende entregas, no vincula ni
  mueve alumnos, no descarga CSV, no usa MCP, no edita trabajos prácticos y no
  ve la pestaña Alumnos. **Un TA sin asignaciones no ve ninguna entrega.**
- **Asignación por trabajo práctico.**
  - En un TP grupal se asignan **equipos**.
  - En uno individual se asignan **padrones de la lista** (`roster_entries`),
    no repositorios. Así se puede repartir antes de que los alumnos acepten, y
    la asignación sobrevive a un cambio de cuenta vinculada. Una cuenta que
    aceptó sin estar en la lista no se puede asignar hasta que la vinculen con
    un padrón.
  - Aunque dos TPs grupales compartan agrupamiento, cada uno se asigna por
    separado.
  - Una fila puede tener **varios TAs**.
  - Se asigna desde el **dashboard del TP**, fila por fila o seleccionando
    varias.
- **El alumno no ve a su TA.** La devolución sigue firmada por la cátedra.
  Puede agregarse más adelante.

## Modelo de datos

Dos tablas nuevas, sin tocar `organizations_users`.

### `teaching_assistants`

| Columna | |
|---|---|
| `id` | serial |
| `organization_id` | FK `organizations`, `on delete cascade` |
| `user_id` | FK `users`, `on delete cascade` |
| `created_by_user_id` | FK `users`: el profesor que lo cargó |
| `created_at` | |

Índice único `(organization_id, user_id)`, y `unique (id, organization_id)`
para que la tabla siguiente pueda atar el TA al classroom con una FK
compuesta.

Si el TA nunca entró a la app, no tiene fila en `users`. Se la crea a partir
de `GET /users/{login}` (`uid`, `github_login`, avatar), y su primer login la
actualiza: `auth.ts` ya hace `onConflictDoUpdate` sobre `uid`.

### `teaching_assistant_allocations`

Una fila por (TA, fila del dashboard). Lleva una FK por tipo de trabajo
práctico, el mismo patrón que `checkpoints`, `submissions` y
`submission_exemptions` (`lib/data/assignment-kind.ts`).

| Columna | |
|---|---|
| `id` | serial |
| `teaching_assistant_id` | FK `teaching_assistants`, `on delete cascade` |
| `assignment_id` + `roster_entry_id` | TP individual |
| `group_assignment_id` + `group_id` | TP grupal |
| `created_by_user_id` | FK `users` |
| `created_at` | |

- **CHECK:** exactamente uno de los dos pares está completo, y el otro es
  null.
- **Índices únicos parciales:**
  - `(teaching_assistant_id, assignment_id, roster_entry_id)` donde `assignment_id is not null`;
  - `(teaching_assistant_id, group_assignment_id, group_id)` donde `group_assignment_id is not null`.

  Asignar dos veces lo mismo no hace nada.
- **`on delete cascade`** hacia el padrón y el equipo. Si se borra el padrón o
  el equipo, la asignación desaparece con él. Las devoluciones no dependen de
  esta tabla, así que no se pierde nada.
- **Pertenencia.** Que el equipo sea del agrupamiento del TP y que el padrón
  sea de la lista del classroom se valida en TypeScript, en `lib/data/`. Si
  sale barato, se refuerza con FKs compuestas como
  `groups_grouping_id_organization_id_fkey`. Nada de triggers.

Sacar un TA borra su fila de `teaching_assistants` y, por cascada, todas sus
asignaciones. Sus devoluciones quedan: `submission_feedbacks.created_by_user_id`
apunta a `users`, no a esta tabla.

## La frontera de autorización

Hoy todo `lib/data/` autoriza con un `inner join organizations_users`. Está
en `findTeachingClassroom`, en `findTeachingAssignment` y en unos pocos joins
sueltos: `rosters.findClassroomRow`, `invitations.listAssignmentAcceptances`,
`grading.leaseSubmissionForGrading`, y los del índice.

**Por eso los TAs van en una tabla aparte y no en una columna de rol.** Una
columna `role` en `organizations_users` haría que cada join existente dejara
pasar a los TAs como profesores, empezando por borrar trabajos prácticos y
archivar classrooms. Con una tabla aparte, todo lo que existe sigue siendo
solo para profesores **sin tocarlo**. A los TAs se les abren, una por una,
únicamente las funciones de esta lista:

| Función | Qué ve el TA |
|---|---|
| `listAssignments`, `listGroupAssignments`, `countAssignments` | todos los TPs del classroom |
| `listAssignmentAcceptances` | solo los padrones que tiene asignados |
| `listGroupAssignmentAcceptances` | solo los equipos que tiene asignados |
| `listAssignmentSubmissions` | solo las entregas de esas filas |
| `findSubmissionPanels`, `findSubmissionHistory`, `findSubmissionDetail` | solo para un repositorio de sus filas; si no, `null` y 404 |
| `saveSubmissionFeedback` | ídem |

- **Cómo se resuelve el rol.** Un helper nuevo, `findClassroomRole(session,
  slug)`, devuelve `{ role: 'teacher' | 'assistant', classroom }` o `null`.
  Primero mira `organizations_users`, porque el profesor gana: si alguien
  quedó en las dos tablas, es profesor. Las funciones de la tabla lo usan; las
  demás siguen con `findTeachingClassroom` tal cual.
- **Un ayudante que se vuelve alumno pierde el rol.** Cargar a un alumno como
  ayudante se rechaza, pero nada en los flujos del alumno (aceptar un TP,
  vincularse a un padrón, entrar a un equipo) sabe que existen los ayudantes.
  Por eso `findClassroomRole` tampoco da el rol a quien es alumno del
  classroom. Las dos puntas usan la misma definición, `isStudentOf` en
  `lib/data/classroom-students.ts`: padrón vinculado, invitación aceptada
  (aunque el repo todavía no exista), repo de un TP individual o lugar en un
  equipo.
- **Cómo se filtran las filas.** El filtro va en la consulta (un `exists`
  sobre `teaching_assistant_allocations`), no después de traer todo. Así el
  `listRepositorySnapshots` del dashboard solo le pide a GitHub los
  repositorios del TA.
- **Sesiones de API key.** Cualquier usuario puede crear una API key en
  `/settings/api-keys`, y un TA también puede ser profesor en otro classroom,
  así que no alcanza con impedirle crearla. El callback `session` de
  `auth.ts` marca cada login del navegador con `via: 'browser'`, y
  `findClassroomRole` solo devuelve `assistant` para una sesión con esa marca.
  `sessionFromApiKey` pone `via: 'api-key'`, y una sesión armada a mano en
  otro lado no tiene ninguna: las dos quedan afuera por defecto. Las
  herramientas MCP llaman a las mismas funciones, de modo que quedan cerradas
  para los TAs sin tocarlas.
- **Worker de corrección.** `leaseSubmissionForGrading` solo mira
  `organizations_users`. No cambia.

## Pantallas

### Pestaña "Docentes"

Es la tercera pestaña del sitio vivo ("TAs and Admins"). Ruta
`/classrooms/<slug>/settings/invitations`, la misma del original y del sitio
vivo (`organizations#invitation`). Solo para profesores; un TA no ve la
pestaña.

- **Profesores.** La lista de `organizations_users`, con avatar y login, sin
  botón para sacar. Lleva una nota, adaptada de `_invite_users.html.erb`: los
  profesores son los owners de @org, se agregan desde
  `github.com/orgs/<org>/people` y entran solos al abrir el classroom.
- **Ayudantes.** La lista de `teaching_assistants`, cada uno con "Sacar" y un
  modal de confirmación. El modal avisa que se borran sus asignaciones y que
  sus devoluciones quedan.
- **Agregar ayudante.** Un campo para el login de GitHub. Se rechaza en estos
  casos:
  - la cuenta no existe;
  - ya es ayudante de este classroom;
  - ya es profesor de este classroom;
  - es alumno de este classroom (`isStudentOf`, ver arriba).

El contador del tab suma profesores y ayudantes, como "TAs and Admins 1".

`ClassroomNav` pasa de dos pestañas a tres. Settings sigue afuera.

### Vinculación por URL directa

Se agrega a `findClassroom` lo que hace
`ensure_current_organization_visible_to_current_user`: si el usuario no está
en ninguna de las dos tablas pero es owner de la org, se lo agrega como
profesor. Así un TA ascendido a owner pasa a profesor la próxima vez que
abre el classroom, no solo cuando abre el índice.

### Índice de classrooms para un TA

`listClassrooms` arranca de `GET /user/installations`, que a un TA no le
devuelve la org porque no es miembro. Sus classrooms se suman aparte, desde
`teaching_assistants`, y la org de cada uno se resuelve con el token de la
instalación (`findOrganizationByInstallation`).

Si el `installation_id` guardado está vencido, el TA no puede re-resolverlo:
`reresolveInstallation` usa las instalaciones del usuario. En ese caso la
tarjeta se muestra como inalcanzable, el patrón `NullGitHubRepository`, hasta
que un profesor abra el classroom.

La tarjeta de un TA no tiene el menú kebab: archivar es de profesores.

### Lista de trabajos prácticos, vista por un TA

Las mismas filas, sin "Copiar link de invitación", sin editar y sin borrar.
Cada fila sigue llevando al dashboard.

### Dashboard del TP, vista por un profesor

- Una columna o etiqueta por fila con los ayudantes asignados, y un menú
  (`details`/`SelectMenu`) para marcar o desmarcar ayudantes.
- **Asignación en lote.** Casillas por fila y una barra "Asignar a…" que
  agrega el ayudante elegido a todas las filas marcadas.
- **Filtro nuevo** "Ayudante: todos / sin asignar / @x", en el browser como
  los demás filtros. Sirve para ver qué falta repartir.
- **En un TP individual** se asignan solo las filas de padrones. Las cuentas
  sin vincular no tienen casilla.
- **En un TP grupal** solo hay equipos para asignar una vez que los alumnos
  los forman, porque los equipos nacen ahí.

### Dashboard del TP, vista por un ayudante

- Solo sus filas.
- Los `StatTiles` cuentan sobre esas filas.
- Sin CSV, sin extensión, sin justificar y sin "Publicar".
- Si no tiene filas asignadas, un estado vacío: "Todavía no tenés alumnos
  asignados en este trabajo práctico".

### Detalle de una entrega, vista por un ayudante

Ve el historial, la corrección automática y la devolución. Puede escribir la
devolución. No ve la justificación de entrega tardía, que es solo para
profesores por los datos personales que puede tener
(`late_submission_justifications.reason`), ni los botones de justificar,
extender o publicar.

## Tests

- **Sobre PGlite:**
  - el CHECK y los índices únicos parciales de las asignaciones;
  - la cascada al sacar un TA y al borrar un padrón o un equipo;
  - que un TA no ve filas ajenas en cada función de la tabla de arriba;
  - que un TA no pasa `findTeachingClassroom` en ninguna escritura;
  - que una sesión de API key de un TA no ve nada;
  - que el profesor gana cuando alguien está en las dos tablas.
- **Del original:** no hay spec para portar. `organizations_controller_spec`
  solo cubre `remove_user` de owners, que acá no existe.

## Abierto, decidir al implementar

- **Texto de la UI:** "ayudante" o "TA". La spec usa "ayudante", que es como
  se dice en FIUBA. Sumarlo a `glosario-ui-en-espanol`.
- **Si un ayudante ve la pestaña Docentes en solo lectura.** Por ahora no.

## Orden de trabajo

1. Migración y tablas. Se genera la migración; **no se aplica a producción
   sin permiso explícito**.
2. `findClassroomRole`, la marca de las sesiones de API key y los tests de
   frontera.
3. Pestaña Docentes: listar, agregar y sacar ayudantes.
4. Asignación en los dos dashboards del profesor.
5. Vista del ayudante: índice, lista de TPs, dashboards filtrados, detalle y
   devolución.
6. Entrada en `AGENTS.md`, en "Deliberate divergences".
