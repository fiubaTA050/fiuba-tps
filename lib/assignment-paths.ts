/**
 * Individual or group: which of the two assignment tables an entrega hangs
 * off. Defined here and not in lib/data/assignment-kind.ts, which is
 * server-only, because the dashboard's client components route by it too.
 */
export type AssignmentKind = 'individual' | 'group'

/** The teacher's page of one assignment, which every entrega screen hangs under */
export function assignmentPath(
  classroomSlug: string,
  kind: AssignmentKind,
  assignmentSlug: string,
): string {
  const segment = kind === 'group' ? 'group-assignments' : 'assignments'
  return `/classrooms/${classroomSlug}/${segment}/${assignmentSlug}`
}

/**
 * The `kind` a form or a query string carries. Anything but `group` is the
 * individual kind, the one every form posted before group entregas existed —
 * and a wrong kind only ever finds nothing, since the data layer still checks
 * the assignment belongs to a classroom the caller teaches.
 */
export function parseAssignmentKind(value: FormDataEntryValue | null): AssignmentKind {
  return value === 'group' ? 'group' : 'individual'
}
