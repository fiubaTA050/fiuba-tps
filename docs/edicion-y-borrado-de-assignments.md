# Editar y borrar assignments

Spec escrita el 15/08/2026 para hacerse en otra sesión. Cubre los tres huecos
que separan "se puede dar un TP" de "se puede dar un TP y administrarlo":
cerrar la entrega, corregir un assignment ya publicado, y borrarlo.

## Por qué son dos pantallas y no tres

El código archivado tiene **tres** cosas separadas: un `toggle_invitations` en la
página del assignment, un `#edit`/`#update`, y un `#destroy`.

El sitio vivo las juntó. Hoy no hay checkbox en la página del assignment: hay un
desplegable **"Assignment status" con Active / Inactive** dentro de **Edit
assignment**. La doc oficial lo dice así:

> *"To change the status of an assignment, select the **Assignment status**
> dropdown menu, then click **Active** or **Inactive**. Inactive assignments
> cannot be accepted by students. You should change an assignment status to
> inactive once no more students should accept an assignment or the assignment
> deadline has passed."*
>
> — [Editing an assignment](https://docs.github.com/en/education/manage-coursework-with-github-classroom/teach-with-github-classroom/editing-an-assignment)

Seguimos al sitio vivo, por la misma razón que ya está en `AGENTS.md`: es el que
la cátedra usa todos los días, y "cerrar la entrega" lo tiene aprendido como
*poner el assignment en Inactive desde Edit*.

De paso nos ahorra portar un bug. El `toggle_invitations` archivado **estaba roto
justo para los grupales**: posteaba a `/assignments/:slug/toggle_invitations` en
vez de `/group-assignments/...`, así que el checkbox se quedaba cargando para
siempre ([issue #2555](https://github.com/github-education-resources/classroom/issues/2555),
cerrado). Hay más de la misma familia:
[#1592](https://github.com/education/classroom/issues/1592) (destildarlo no
impedía que el link funcionara) y
[#1482](https://github.com/github-education-resources/classroom/issues/1482) /
[#2548](https://github.com/education/classroom/issues/2548) (la página
deshabilitada igual parecía aceptable — eso ya lo resolvimos de entrada,
nuestras pantallas muestran el motivo antes del botón).

## No hace falta ninguna migración

Verificado campo por campo contra `db/schema.ts`. Todo lo que la pantalla toca
ya existe, en `assignments` y en `group_assignments`:

| Campo de la pantalla | Columna |
|---|---|
| Assignment status (Activo/Inactivo) | `invitations_enabled` |
| Título | `title` |
| Prefijo de los repositorios | `slug` |
| Visibilidad | `public_repo` |
| Admin del alumno | `students_are_repo_admins` |
| Starter code | `starter_code_repo_id` |
| Máximo de integrantes / de equipos | `max_members`, `max_teams` (sólo grupales) |

Lo demás de la pantalla viva —deadline, autograding, rutas protegidas, feedback
PRs, IDE— pide tablas que no tenemos, y son divergencias deliberadas ya
documentadas. Quedan fuera.

## Decisiones

### Qué se propaga a los repos que ya existen: nada

El original propaga **una sola** cosa. `Assignment::Editor#perform` recorre
`previous_changes` y su `update_attribute_for_all_assignment_repos` tiene un
`case` con un único `when`: `public_repo`, que encola
`AssignmentRepositoryVisibilityJob` para dar vuelta la visibilidad de todos los
repos ya creados. Título, prefijo, starter code y permiso de admin no tocan nada
de lo existente.

Acá **tampoco la visibilidad**. No hay cola, y hacerlo en el request del docente
son N llamadas a GitHub —100 alumnos, 100 repos— contra un techo de 60 s de
función. El cambio vale para los repos nuevos y la pantalla lo dice, que es
exactamente la postura que el propio original ya tiene para el permiso de admin
("*Editing this after assignments are created will not retroactively change
their permissions*", leyenda que ya copiamos en los dos formularios).

Cuando exista ejecutor —la condición está escrita en
`docs/creacion-de-repos.md`— esto es un `step.run` y se revisa.

### Cambiar el prefijo con repos ya creados

Se permite, y sólo afecta a los repos futuros: los ya creados conservan su
nombre, que es lo que hace el original al no propagar `slug`. La leyenda del
formulario tiene que decirlo.

Ojo con la validación: el prefijo sigue siendo único **en toda la organización
de GitHub** y contra los dos tipos de assignment (`findSlugClash` en
`lib/data/assignment-fields.ts`). Al editar hay que **excluir el propio
assignment** de esa búsqueda, o guardar sin cambiar el prefijo va a chocar
consigo mismo. Mismo cuidado con `isTitleTaken`.

### Borrar: qué pasa con los repos de los alumnos

**Decidido el 15/08/2026 con el docente: borrado lógico y nada más.**
Implementado así en `deleteAssignment` y `deleteGroupAssignment`, y anotado como
divergencia en `AGENTS.md`.

Al decidirlo se verificó una cosa que esta spec daba por abierta: **el sitio vivo
sigue borrando los repos**, no sólo el código archivado. El modal archivado
`_delete_assignment_modal.html.erb` ya lo decía —"this will also delete N
participant repository under the X organization", con el nombre del assignment
tipeado para confirmar— y en
[community#134180](https://github.com/orgs/community/discussions/134180)
(jul 2024) un docente lo confirma sobre classroom.github.com. En
[#135806](https://github.com/orgs/community/discussions/135806) hay un caso de
agosto 2024 de alguien que borró un assignment desde Edit sin querer y se llevó
100+ repos: ése es exactamente el modo de falla que evitamos.

Como acá no se va nada de GitHub, el botón no pide tipear el nombre: alcanza un
`confirm`, igual que el resto de las acciones destructivas del port.

El original borra los repos. `AssignmentsController#destroy` hace un borrado
lógico (`deleted_at`) y encola `DestroyResourceJob`, que hace `resource.destroy`;
`assignment_repos` es `dependent: :destroy`, y cada uno tiene un `before_destroy`
—`AssignmentRepoable#silently_destroy_github_repository`— que llama a
`delete_repository(github_repo_id)`. O sea: **borrar un assignment borra de
GitHub el trabajo de todos los alumnos**, en background y sin vuelta atrás. La
doc del sitio vivo no menciona esto en ninguna parte.

Recomendación para este port: **borrado lógico y nada más**. Poner `deleted_at`
alcanza para que el assignment desaparezca de la UI y para liberar el título y
el prefijo —los índices únicos parciales ya están hechos con `where deleted_at
is null`, así que eso funciona solo— y los repos quedan en la organización. Para
una cátedra el repo es la entrega y la evidencia de la corrección; que un click
en "Borrar" se lleve 100 entregas es un modo de falla peor que dejar repos de
más. Si algún día se quiere el borrado en GitHub, que sea una acción aparte y
explícita, con confirmación tipeando el nombre.

Va documentado como divergencia citando `app/models/concerns/assignment_repoable.rb:10`.

### Lo que no se puede editar

El **tipo** de assignment. La doc viva: *"you cannot change the assignment type
(either individual or group) … after assignment creation"*. Y el **conjunto de
equipos** de un grupal, que en el original sólo aparece en el formulario dentro
de `if @group_assignment.new_record?` — nuestro formulario ya hace lo mismo.

## Alcance

Dos pantallas de edición, una por tipo, casi idénticas: los grupales agregan los
dos máximos y muestran el conjunto de equipos como dato de sólo lectura. Más el
borrado, desde la misma pantalla.

Al editar `max_teams` hay que revalidar `max_teams_less_than_group_count` contra
los equipos que el conjunto ya tiene — el original tiene dos mensajes distintos
para alta y edición (`group_assignment.rb:78`), y el de edición es el que falta.

## Archivos

- `app/classrooms/[slug]/assignments/[assignmentSlug]/edit/` — page, form, actions.
- `app/classrooms/[slug]/group-assignments/[assignmentSlug]/edit/` — ídem.
- `lib/data/assignments.ts` y `lib/data/group-assignments.ts` — `updateAssignment`
  y `deleteAssignment`, con sus equivalentes grupales.
- `lib/data/assignment-fields.ts` — `findSlugClash` necesita un parámetro para
  excluir el assignment que se está editando.
- Las páginas de cada assignment — botón "Editar", y el estado Inactivo visible.
- `components/`, si el formulario de alta y el de edición terminan compartiendo
  campos; el de alta ya está bastante factorizado.

Reusar tal cual: `validateTitleAndSlug`, `resolveStarterCode`,
`findTeachingClassroom`, `StarterCodeField`.

## Tests

Del original se portan las specs de `spec/models/assignment/editor_spec.rb` —el
`"can update attributes"` y el `context "public_repo is changed"`, que acá se
invierte: **no** se propaga— y los `#update`/`#destroy` de
`spec/controllers/assignments_controller_spec.rb`, incluido `context "slug is
empty"`.

Casos propios que no están en el original:

- Guardar sin tocar el prefijo no choca consigo mismo.
- Cambiar el prefijo a uno que usa otro classroom de la misma org de GitHub
  falla, y el mensaje nombra al classroom.
- Poner el assignment en Inactivo hace que `acceptInvitation` y
  `acceptGroupInvitation` fallen con `INVITATIONS_DISABLED` — ya hay cobertura
  del rechazo, falta la del camino que lo activa.
- Un assignment borrado desaparece de `listAssignments` y su link de invitación
  responde 404, y su título y prefijo quedan libres para uno nuevo.
- Bajar `max_teams` por debajo de los equipos existentes falla, con el mensaje
  de edición.

## Verificación

`npm test`, y una pasada a mano con la cuenta de docente sobre
`fiuba-tps.vercel.app` o local: crear un assignment, aceptarlo con una cuenta de
afuera, ponerlo en Inactivo y comprobar que el link de invitación deja de
aceptar, y que el repo ya creado sigue accesible para el alumno. No hace falta
device flow: la parte de docente no necesita el token del alumno.

Para las cuentas externas y sus tokens, ver `docs/creacion-de-repos.md`.
