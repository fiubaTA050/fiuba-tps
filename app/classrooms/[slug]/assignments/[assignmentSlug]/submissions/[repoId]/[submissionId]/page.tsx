import { SubmissionDetail } from '@/components/SubmissionDetail'

export const dynamic = 'force-dynamic'

/** One student's entrega, teacher-facing — see components/SubmissionDetail */
export default function SubmissionDetailPage(
  props: PageProps<'/classrooms/[slug]/assignments/[assignmentSlug]/submissions/[repoId]/[submissionId]'>,
) {
  return <SubmissionDetail kind="individual" params={props.params} />
}
