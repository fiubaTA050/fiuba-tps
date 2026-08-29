# Cómo entrega un alumno, y por qué no lo congela un proceso

Registro de las decisiones tomadas el 26/08/2026 y el 29/08/2026, con las
mediciones que las sostienen. Si estás por agregar un cron, una deadline en la
fila del assignment, o un tope de entregas, leé esto primero.

## La decisión

**El alumno indica un ref de su repositorio y confirma.** Eso resuelve el ref
contra GitHub y congela un SHA, que es el árbol que el docente corrige.

Nadie más escribe una entrega. No hay job, no hay cola, no hay cron, no hay nada
que corra sola al vencer una fecha. La regla es **no confirmó = no entregó**: el
alumno que pusheó y no apretó el botón queda como *Sin confirmar* en el
dashboard, con sus commits a la vista, y el docente decide qué hacer con eso.

## Qué hace el original, y por qué no se copia

El original **no tiene entrega del alumno**. Lo más parecido es
`assignment_repos.submission_sha`, que escribe `DeadlineJob#fetch_submission_sha`
(`app/jobs/deadline_job.rb:15`) con el HEAD de cuando el job despierta: el alumno
nunca declara nada, y la deadline no cierra nada — no bloquea pushes ni
invitaciones.

Ese job tiene tres agujeros conocidos: editar la deadline no cancela el job
viejo, un job perdido (Redis vacío, un deploy) no lo revive nadie, y el SHA
termina siendo el del momento en que el worker logró correr, no el del
vencimiento.

Lo que sí se porta literal es la vista del docente:
`SharedAssignmentRepoView#submission_sha_url` ya es `tree_url_for_sha(submission_sha)`
(`shared_assignment_repo_view.rb:65`).

## Por qué el alumno declara el SHA en vez de que lo lea el sistema

Porque **no se puede reconstruir con confianza qué tenía un repositorio en un
instante pasado**. Medido contra la API real el 25/08/2026, org
`concurrentes-fiuba`:

- **Las fechas de los commits son falsificables.** `GIT_COMMITTER_DATE` y
  `git commit --date` las escriben sin validación, y un rebase además las mueve
  solo. Demostrado creando un commit fechado en abril.
- **No existe forma de pedir "el último commit pusheado antes de X" en
  GraphQL.** `Commit.history` acepta sólo `after, before, first, last, path,
  author, since, until`, y `since`/`until` son `GitTimestamp` sobre la fecha del
  commit — la falsificable. `Commit.pushedDate`, que era exactamente eso, está
  deprecado (*"Removal on 2023-07-01 UTC"*), sigue en el schema y devuelve
  `null` en todos los commits reales. De fondo: git no guarda la hora de push,
  es un evento del servidor.
- **`Repository.pushedAt` es del repo entero, no de la rama default.** Medido:
  en `concurrentes-fiuba.github.io` valía 14:35:42 por un push del bot a
  `refs/heads/published`, mientras `main` se había pusheado 14:35:21.

Lo único que sabe la hora de servidor por rama es la Activity API
(`GET /repos/{owner}/{repo}/activity`, filtrable por `activity_type` y `ref`).
Un diseño anterior la usaba desde un cron diario para congelar el SHA de los que
no confirmaran; se descartó junto con el cron. Queda anotada acá como hecho
medido, no como plan.

## Qué es un checkpoint

**Un checkpoint es una entrega.** No es "una parte opcional de un TP": es la
cosa contra la cual se entrega.

De ahí la regla: **si un assignment no tiene checkpoints, no hay nada que
entregar**. Cero checkpoints es un estado legal y quiere decir que el docente
todavía no habilitó las entregas. No se autocrea uno al crear el assignment y no
hubo backfill de los que ya existían.

El caso que obligó a esta forma es concreto y conocido: **el TP2 va a tener
cuatro entregas —2A, 2B, 2C y 2D— cada una con su propia fecha**, sobre el mismo
repositorio. Por eso la deadline vive en el checkpoint y no en la fila del
assignment, que es donde la tenía el original (`deadlines`, una por assignment).
Un TP de una sola fecha no es un caso aparte: es un checkpoint solo.

Un checkpoint puede no tener fecha (`deadline_at` NULL), que es el TP habilitado
cuya fecha todavía no se decidió. Por eso el orden lo da `position` y no la
fecha.

## Qué hace una deadline

Dos cosas, y nada más:

1. decide **tarde / a tiempo**, comparando `submitted_at` con `deadline_at`;
2. avisa al alumno, antes de confirmar, que va a quedar marcada como tarde.

**No cierra nada.** Las entregas tardías se aceptan y se marcan `Tarde`
(decisión del 29/08/2026). Rechazar a las 23:50 es irreversible para el alumno;
una entrega tardía visible el docente la ignora si quiere, y la cátedra se queda
con el dato de que el trabajo existía.

Lo único que cierra las entregas sigue siendo **poner el assignment en
Inactive**, que es la palanca que ya existe y que documenta
`edicion-y-borrado-de-assignments.md`. Esa es también la semántica del original,
donde la deadline tampoco bloqueaba nada.

## Append-only

**Reentregar es una fila nueva, nunca un `UPDATE`.** No hay índice único por
(repo, checkpoint): la entrega vigente es la última fila, y el `id` serial es lo
que desempata — no `submitted_at`, que puede empatar.

El argumento no es la auditoría, es este: **con deadline por entrega, una
reentrega tardía pisaría la entrega que estaba a tiempo**. Con append-only "lo
que hay que corregir" es una consulta —*la última con `submitted_at <=
deadline`*— y el docente decide si mira esa o la tardía. Es la diferencia entre
poder tener política de entregas tarde y no poder.

Consecuencias:

- **No se copia el "activar una entrega anterior" de Gradescope.** Si el alumno
  quiere una versión vieja, la reentrega: queda registrado que la eligió *en ese
  momento*, que es más honesto que resucitar una fila.
- **El alumno no borra entregas.** Ni existe la operación, igual que allá.
- **Mismo SHA que la última = no-op.** Confirmar dos veces lo mismo no es una
  entrega nueva; es lo que cubre el doble click, y hace innecesario el índice
  único que el diseño inicial quería.
- Una fila son 40 bytes de SHA. ~100 alumnos × 4 entregas × un puñado de
  confirmaciones no es un problema de tamaño.

## Resolver el ref

El alumno puede escribir cualquier cosa que git resuelva **del lado del
servidor**, que es lo que acepta `object(expression:)` de GraphQL. Medido el
29/08/2026 contra la org real, ~380 ms por consulta:

| lo que escribe | resultado |
|---|---|
| `main` (rama default) | resuelve |
| SHA completo (40) | resuelve |
| SHA abreviado (7) | resuelve |
| `main~1` | resuelve al commit anterior |
| `main@{1}` | **también resuelve** — GitHub lo interpreta del lado del servidor, al contrario de lo que suponía este documento |
| rama inexistente | `null`, y no se escribe nada |
| tag liviano | resuelve |
| tag anotado | resuelve **sólo** por el `... on Tag` que desenvuelve el `target` |

El tag anotado no es hipotético: sin desenvolverlo, `object` devuelve un `Tag` y
no un `Commit`, y la entrega se caería. Verificado contra `nodejs/node` y
`git/git`, cuyos tags son anotados (`git-type=tag`), y contra los tags de la
propia org, que son livianos.

Y tampoco es hipotético que los alumnos entreguen por tag: en `fiubaTA050-labs`
varios repos del TP1 de 2026a ya tienen un tag llamado **`Entrega`**, puesto por
los alumnos sin que ninguna herramienta se lo pidiera.

Se guarda lo que el alumno tipeó (`ref`) **y** el SHA resuelto (`sha`). El SHA
es lo inmutable, lo que se corrige; el `ref` es evidencia de intención cuando
viene a reclamar.

**Agujero conocido y aceptado**: GitHub resuelve OIDs de toda la red de forks,
así que un SHA de un fork del repositorio del alumno valida. Chequearlo exacto
es caro y el riesgo es bajo — los repos se generan con
`POST /repos/.../generate`, que no comparte red de objetos con el starter.
Documentado en vez de tapado mal.

Después de resolver hay **una segunda llamada, sólo acá**:
`GET /repos/{owner}/{repo}/compare/{default}...{sha}`, para poder avisar "ojo,
ese commit no está en la rama default". Es **advertencia, no rechazo**: entregar
un tag fuera de la rama default es legítimo. Y es una llamada por confirmación,
no por render, así que no toca la regla de `AGENTS.md` sobre 1N — esa regla es
sobre la latencia del request del docente.

## Por qué un SHA vale como evidencia

Un alumno **puede** sacar un commit de la rama (`reset --hard` +
`push --force`; el port no usa branch protection), pero **no puede borrarlo de
GitHub**: el objeto queda alcanzable por SHA.

Medido sobre un force-push real de un alumno en
`concurrentes-fiuba/2026-1c-tp-fmr`, del 08/06/2026, `before` `ed1150f9` →
`after` `c351ca73`: el commit desplazado seguía devolviéndose por la API el
25/08/2026, **2,5 meses después**, con mensaje y fecha intactos. El link a
`/tree/<sha>` sigue abriendo el árbol entregado aunque el alumno reescriba la
rama.

Salvedades: no es garantía eterna (GitHub recolecta objetos inalcanzables), y
**borrar el repositorio entero sí destruye todo** — eso el port ya lo trata como
repo inalcanzable.

**Limitación conocida: guardamos un puntero, no los bytes.** Gradescope se copia
el código; acá se guarda un SHA. Paridad real sería archivar un tarball por
entrega: otra feature y otro costo, deliberadamente fuera de alcance.

## Cooldown sí, tope de entregas no

**No hay tope de entregas.** Acá una confirmación es una query GraphQL y un
INSERT, y la corrección es humana sobre un commit: no hay autograder que tantear
ni cómputo que proteger. Un tope no compra nada y sí genera "profe, me quedé sin
intentos" a las 23:50. El que reentrega ocho veces está trabajando, no atacando.

Es lo que hacen los productos de referencia, mirados el 26/08/2026: Gradescope
no tiene campo de máximo para programming assignments —le pasa
`previous_submissions` al autograder y le dice al docente que se programe el
límite ahí—, y Autolab, que sí tiene `max_submissions`, admite `-1 = ilimitado`
y ofrece descontar puntos en vez de cortar. El patrón es claro: el que limita,
limita porque cada entrega dispara **corrección automática**. Acá no hay.

**Pero sí hay cooldown**, y protege un recurso compartido real: el **rate limit
de la instalación de GitHub**, medido en `x-ratelimit-limit: 12500` por hora
**para toda la instalación**, el mismo presupuesto que gastan los dashboards de
todos los docentes. Cada confirmación son 1-2 llamadas, así que mil
confirmaciones se comen hasta dos mil justo en la semana de entrega. El alumno
con un script no se rompe el pie a sí mismo: se lo rompe a la cátedra.

**El dedupe no lo cubre**: si el script commitea antes de cada confirmación son
mil SHAs distintos y pasan todos. Por eso el freno es un cooldown por (repo,
checkpoint), resuelto con una consulta sobre la misma tabla que ya estamos
escribiendo, sin infraestructura nueva.

**La condición que lo cambiaría**: si algún día hay autograding, o la entrega
pasa a costar cómputo, ahí un tope tiene sentido, y la forma a copiar es la de
Autolab —tope configurable o penalización por versión— y no un número arbitrario
puesto hoy.

## Dónde vive la pantalla del alumno

En `/assignment-invitations/[key]/setup`, debajo de la tarjeta del repositorio,
y no en una ruta nueva. **Es la única pantalla del alumno** y el link de
invitación es lo que tiene guardado: cero rutas nuevas, cero superficie de auth
nueva.

En las grupales, el panel dice **quién** entregó por el equipo, y el segundo
integrante que confirma agrega una fila por encima de la del primero, con el
nombre del anterior a la vista antes de apretar. Sin lock: es una corrección
deliberada, no una carrera como la creación del repositorio, y con append-only
nadie pierde lo que había.
