# Teaching assistants

Spec escrita el 11/11/2026, con las decisiones tomadas en la misma
conversación. Cubre cargar TAs en un classroom y asignarles, en cada trabajo
práctico, los alumnos o equipos que corrigen. El acceso a los repositorios
en GitHub vino después (12/11/2026), en "Acceso a los repositorios en GitHub".

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
  mueve alumnos, no descarga CSV, no edita trabajos prácticos y no
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
  - Se asigna desde el **dashboard del TP**, fila por fila o sobre todas las
    filas que dejó el filtro.
  - **Por ahora solo en los TPs grupales** (decidido 2026-11-12): la cátedra
    reparte equipos, no padrones. El TP individual no muestra los controles,
    pero la capa de datos y `AcceptanceList` siguen manejando padrones, así
    que volver a mostrarlo es pasarle `listAllocations(…, 'individual')` en
    su `page.tsx`. Mientras tanto, un ayudante no ve filas en un TP
    individual.
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
- **Solo el login del navegador.** El callback `session` de `auth.ts` marca
  cada login del navegador con `via: 'browser'`, y `findClassroomRole` solo
  devuelve `assistant` para una sesión con esa marca. Una sesión armada a mano
  en otro lado no la tiene y queda afuera por defecto. Hoy las API keys no
  arman sesiones (el worker de corrección solo recibe el id del dueño), pero
  si alguna vez lo hacen — el servidor MCP del PR #5, cerrado sin mergear, lo
  hacía — tampoco darán el rol: cualquiera puede crear una key, y un TA
  también puede ser profesor en otro classroom.
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

- A la derecha de cada fila, entre "Repositorio" y el menú de acciones, un
  botón con los avatares de sus ayudantes (o un ícono de agregar persona si
  no tiene) que abre el menú para marcar o desmarcar ayudantes. Es un botón y
  no avatares sueltos porque la fila de un equipo ya muestra los avatares de
  sus integrantes al lado.
- **Asignación en lote, sin casillas.** Con algún filtro o búsqueda activa, el
  encabezado de la lista ofrece "Asignar estas N a…" (y "Quitar a"), que
  actúa sobre todas las filas filtradas, de todas las páginas. Filtrar "Sin
  asignar" y asignar es el caso típico. Hubo casillas por fila y una barra
  que aparecía al marcar: empujaba la lista hacia abajo bajo el mouse y no
  gustó (2026-11-12). Un botón "Repartir" que divide en tramos se descartó.
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

## Acceso a los repositorios en GitHub

Decidido el 12/11/2026. El ayudante lee los repositorios de *sus* equipos
como **outside collaborator con permiso `pull`**: el mismo mecanismo que usa
un alumno, con `push` (`docs/creacion-de-repos.md`). No se lo hace miembro de
la organización: sería otra invitación para aceptar, y no le daría nada que no
tenga como colaborador. El código no lo distingue: a un miembro GitHub lo
agrega directo con 204, sin invitación.

Solo en los TP grupales por ahora, porque solo ahí hay controles para
asignar. `teaching_assistant_repo_accesses` tiene una sola clave, a
`group_assignment_repos`; el individual sería una segunda, como en
`checkpoints`.

- **La asignación dice qué debería tener; la tabla, qué se hizo.**
  `teaching_assistant_repo_accesses` es una fila por repo al que se lo agregó.
  Sin ella cada visita volvería a mandar la invitación, y al sacar un
  ayudante no habría forma de saber qué repos devolver.
- **Se da cuando el ayudante abre el dashboard del TP.** Aceptar la invitación
  necesita el token del propio ayudante, igual que con un alumno, así que no
  se puede hacer cuando el profesor asigna. Corre en `after()`, después de
  mandar la página: `addCollaborator` con `pull` y
  `acceptRepositoryInvitation` con su token, en tandas de 5 y hasta 20 repos
  por visita (cada uno son dos requests que crean contenido, y el límite es
  80 por minuto). Un repo que el equipo crea después de la asignación entra
  en la próxima visita. En un classroom archivado no se da nada. Se invita al
  login que la cuenta tiene **ahora**, buscado por id: el de la sesión es el
  del día que entró, y tras un rename lo puede tener otra persona. La fila se
  guarda apenas existe la invitación, antes de aceptarla: si aceptar falla, la
  invitación queda en su mail y no se le vuelve a mandar en cada visita.
- **Se saca cuando el profesor desasigna o saca al ayudante.** Eso solo
  necesita la instalación. El login se busca por id (`GET /user/{id}`) porque
  el de `users` puede estar viejo, y GitHub contestaría 404 a un login
  renombrado, que se leería como "ya no estaba".
  - Al desasignar es de mejor esfuerzo: la asignación se borra igual, y lo
    que falla deja su fila para el próximo intento.
  - Al sacar al ayudante, los repos se devuelven **antes** de borrarlo,
    porque las filas caen en cascada con él. Si GitHub falla en alguno, el
    ayudante queda y el profesor ve "Probá de nuevo". El borrado bloquea la
    fila del ayudante y solo procede si no le quedó ningún acceso: un acceso
    que el dashboard le dio en el medio se devuelve en otra vuelta, y uno
    posterior espera el lock, choca con la clave foránea y se devuelve solo.
  - **Solo un 404 cuenta como "el repo ya no está".** Un error de GitHub deja
    la fila y cuenta como falla; leerlo como borrado dejaba al ayudante
    adentro sin registro (lo encontró el code review). Por lo mismo, la
    instalación se re-resuelve antes (`currentInstallationId`): con una
    vieja, hasta el token da 404.
- **Lo que se escapa lo arregla la pasada siguiente.** La visita del ayudante
  también saca, en ese TP, lo que ya no tiene asignado. Si el profesor lo saca
  mientras se le está dando acceso, el insert choca con la clave foránea y se
  le saca en el momento.
- **GitHub manda el mail igual.** Su documentación dice que el invitado
  recibe una notificación, y llega aunque la invitación ya esté aceptada. Es
  un mail por repo, sin nada que clickear.

Verificado contra GitHub real el 12/11/2026, en la base local, con
`@eespina-hu` (no es miembro de la org, así que pasa por la invitación de
verdad) sobre el repo descartable `zzz-seed-espinaemmanuel`: al abrir el
dashboard quedó como outside collaborator `read` con 0 invitaciones
pendientes, y al desasignarlo desde el dashboard del profesor se fue del repo
y de la tabla. La desasignación tardó ~1,8 s, por las tres llamadas a GitHub.
Después de los arreglos del code review se repitió el alta, y "Sacar
ayudante" en la pestaña Docentes lo sacó del repo antes de borrarlo.

Lo que no cubre: si un ayudante pasa a ser alumno del classroom,
`findClassroomRole` le niega el rol pero el acceso en GitHub queda hasta que
el profesor lo saca. Si se borra un equipo, su fila en
`group_assignment_repos` se va en cascada y el repo sigue en GitHub con el
ayudante adentro.

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

## Estado (11/11/2026)

Hechos los pasos 1 a 6. Lo que la implementación agregó a la spec:

- **Cómo se abre un lector.** No con `findClassroomRole` directo: cada función
  que el ayudante puede alcanzar recibe `{ allowAssistant: true }`
  (`StaffAccess`), y sin esa opción sigue siendo solo de profesores. Así la
  edición y los CSV, que comparten esas funciones, quedan cerrados sin
  tocarlos. Las filas se filtran con `visibleRepo` y `allocatedTargets`, en
  `lib/data/staff.ts`.
- **La devolución de un ayudante la aprueba un profesor.** La revisión
  encontró que publicar es por entrega: una vez publicada, cualquier
  devolución nueva le llegaba al alumno en el momento, y eso hacía publicar
  al ayudante de hecho. Ahora lo que guarda un ayudante queda pendiente
  (`submission_feedbacks.needs_approval`) hasta que un profesor aprieta
  "Aprobar" (`submission_feedback_approvals`, una fila por versión, porque
  las versiones no se modifican). El alumno lee la versión más nueva que no
  la necesita o ya la tiene. Solo se aprueba la versión vigente. Lo del
  profesor no necesita aprobación, y lo escrito antes de esto tampoco: por
  eso es una columna con default y no hubo que rellenar nada.
- **Lo que no se hizo:** la vinculación de owners por URL directa (sigue
  siendo desde el índice). El acceso a los repositorios en GitHub se hizo el
  12/11/2026, en su propia sección.

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
