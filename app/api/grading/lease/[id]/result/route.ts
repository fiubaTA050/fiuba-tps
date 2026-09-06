import { NextResponse } from 'next/server'

import { authenticateRequest } from '@/lib/api-key-request'
import { recordGradingResult } from '@/lib/data/grading'

/**
 * The worker posts back what `results.json` said for one lease. See
 * grading-runs-plan for the shape (Gradescope's `{ score, output, tests }`)
 * and for why a lease past its TTL, or already closed, answers 409 rather
 * than silently accepting a late result.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request, 'grading')
  if (!auth.ok) return auth.response

  const { id } = await params
  const leaseId = Number(id)
  if (!Number.isInteger(leaseId)) {
    return NextResponse.json({ error: 'Ese lease no existe.' }, { status: 400 })
  }

  const body = await parseBody(request)
  if (!body) {
    return NextResponse.json(
      { error: 'El body tiene que ser { status: "succeeded" | "failed", score, output, tests }.' },
      { status: 400 },
    )
  }

  const result = await recordGradingResult(auth.auth.apiKeyId, leaseId, body)

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ success: true })
}

type ResultBody = { status: 'succeeded' | 'failed'; score: number | null; output: string | null; tests: unknown }

async function parseBody(request: Request): Promise<ResultBody | null> {
  let json: unknown
  try {
    json = await request.json()
  } catch {
    return null
  }

  if (typeof json !== 'object' || json === null) return null
  const body = json as Record<string, unknown>

  if (body.status !== 'succeeded' && body.status !== 'failed') return null
  if (body.score !== undefined && body.score !== null && typeof body.score !== 'number') return null
  if (body.output !== undefined && body.output !== null && typeof body.output !== 'string') return null

  return {
    status: body.status,
    score: (body.score as number | null | undefined) ?? null,
    output: (body.output as string | null | undefined) ?? null,
    tests: body.tests ?? null,
  }
}
