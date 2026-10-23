import { SubmissionDetail } from '@/components/SubmissionDetail'

export const dynamic = 'force-dynamic'

/** One team's entrega, teacher-facing — see components/SubmissionDetail */
export default function GroupSubmissionDetailPage(
  props: PageProps<'/classrooms/[slug]/group-assignments/[assignmentSlug]/submissions/[repoId]/[submissionId]'>,
) {
  return <SubmissionDetail kind="group" params={props.params} />
}
