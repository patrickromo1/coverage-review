import type { ReviewResult } from '../core/review/result.js';
import { ReviewResultSchema } from '../core/review/result.js';
import { GitHubApiError } from './rest-client.js';
import { CheckAnnotationSchema, type CheckAnnotation, type CheckConclusion, type GitHubClient, type GitHubReviewContext, type PublishingStatus } from './domain.js';

export const CHECK_NAME = 'coverage-review';
export const MAX_ANNOTATIONS_PER_REQUEST = 50;
export const MAX_TOTAL_ANNOTATIONS = 950;

export function checkConclusion(result: ReviewResult): CheckConclusion {
  const value = ReviewResultSchema.parse(result);
  if (value.verdict === 'adequate' && value.analysisStatus === 'complete') return 'success';
  if (value.verdict === 'needs-tests') return 'failure';
  return 'neutral';
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function checkSummary(result: ReviewResult, annotationsTruncated = 0): string {
  const value = ReviewResultSchema.parse(result);
  const limitations = [...new Set(value.limitations.map((item) => item.code))];
  return bounded([
    `Verdict: ${value.verdict}`,
    `Analysis status: ${value.analysisStatus}`,
    `Reviewed scope: ${value.scope.reviewedFiles.length}/${value.scope.changedFiles.length} changed files`,
    `Accepted findings: ${value.findings.length}`,
    `Rejected findings: ${value.rejectedFindings.length}`,
    `Limitations: ${limitations.length ? limitations.join(', ') : 'none'}`,
    ...(annotationsTruncated ? [`Annotations truncated: ${annotationsTruncated}; the JSON artifact retains the complete validated result.`] : []),
  ].join('\n'), 6_000);
}

export function findingAnnotations(result: ReviewResult): CheckAnnotation[] {
  const value = ReviewResultSchema.parse(result);
  return value.findings.flatMap((finding) => {
    const changed = value.scope.files.find((file) => file.path === finding.file);
    const path = finding.side === 'base' && changed?.status === 'renamed' ? changed.previousPath ?? finding.file : finding.file;
    const annotation = CheckAnnotationSchema.safeParse({
      path,
      start_line: finding.line,
      end_line: finding.line,
      annotation_level: finding.severity === 'high' ? 'failure' as const : finding.severity === 'medium' ? 'warning' as const : 'notice' as const,
      title: bounded(`Coverage finding (${finding.side} side, ${finding.suggestedTestLevel})`, 255),
      // Model-authored prose is intentionally kept in the JSON artifact, not in the Check command/API channel.
      message: bounded(`An accepted ${finding.severity}-severity finding identifies this validated ${finding.side}-side changed line. See the coverage-review JSON artifact for details.`, 65_535),
    });
    return annotation.success ? [annotation.data] : [];
  });
}

export async function publishCheck(
  client: GitHubClient, context: GitHubReviewContext, result: ReviewResult, signal: AbortSignal,
): Promise<PublishingStatus> {
  if (!context.headSha) return { status: 'failed', reason: 'invalid-response' };
  const all = findingAnnotations(result);
  const retained = all.slice(0, MAX_TOTAL_ANNOTATIONS);
  const truncated = result.findings.length - retained.length;
  const batches: CheckAnnotation[][] = [];
  for (let index = 0; index < retained.length; index += MAX_ANNOTATIONS_PER_REQUEST) {
    batches.push(retained.slice(index, index + MAX_ANNOTATIONS_PER_REQUEST));
  }
  if (!batches.length) batches.push([]);
  const conclusion = checkConclusion(result);
  const summary = checkSummary(result, truncated);
  try {
    signal.throwIfAborted();
    const created = await client.createCheckRun(context.owner, context.repository, {
      name: CHECK_NAME, headSha: context.headSha, conclusion,
      output: { title: bounded(`Coverage review: ${result.verdict}`, 255), summary, ...(batches[0]!.length ? { annotations: batches[0] } : {}) },
    }, signal);
    for (const annotations of batches.slice(1)) {
      signal.throwIfAborted();
      await client.updateCheckRun(context.owner, context.repository, created.id, {
        name: CHECK_NAME, conclusion,
        output: { title: bounded(`Coverage review: ${result.verdict}`, 255), summary, annotations },
      }, signal);
    }
    return { status: 'published', checkRunId: created.id, annotationsPublished: retained.length, annotationsTruncated: truncated };
  } catch (error) {
    return { status: 'failed', reason: error instanceof GitHubApiError ? error.category : signal.aborted ? 'cancelled' : 'api-error' };
  }
}
