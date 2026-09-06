import { z } from 'zod';
import { ReviewResultSchema } from '../core/review/result.js';
import { FullShaSchema, GitHubReviewContextSchema } from './domain.js';

export const CiReviewArtifactSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  kind: z.literal('coverage-review-result'),
  context: GitHubReviewContextSchema,
  comparisonBaseSha: FullShaSchema.optional(),
  review: ReviewResultSchema,
  publishing: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('not-requested') }),
    z.strictObject({ status: z.literal('published'), checkRunId: z.number().int().positive(), annotationsPublished: z.number().int().nonnegative(), annotationsTruncated: z.number().int().nonnegative() }),
    z.strictObject({ status: z.literal('failed'), reason: z.enum(['missing-token', 'permission-denied', 'cancelled', 'api-error', 'invalid-response']) }),
  ]),
}).superRefine((artifact, context) => {
  if (artifact.review.schemaVersion !== '1') context.addIssue({ code: 'custom', message: 'Local snapshot artifacts are not publishable' });
  if (artifact.review.provenance.executionMode !== 'github') context.addIssue({ code: 'custom', message: 'CI artifact must contain a GitHub execution result' });
  if (artifact.context.headSha && artifact.review.scope.headSha !== artifact.context.headSha) context.addIssue({ code: 'custom', message: 'Review head does not match event head' });
  if (artifact.comparisonBaseSha && artifact.review.scope.baseSha !== artifact.comparisonBaseSha) context.addIssue({ code: 'custom', message: 'Review base does not match resolved comparison base' });
  if (artifact.review.scope.resolved && !artifact.comparisonBaseSha) context.addIssue({ code: 'custom', message: 'Resolved review is missing its comparison base' });
  if (artifact.publishing.status === 'published' && artifact.context.kind !== 'pull-request') context.addIssue({ code: 'custom', message: 'Checks may be published only for pull requests' });
});
export type CiReviewArtifact = z.infer<typeof CiReviewArtifactSchema>;

/** Strict provenance validation for any future privileged artifact consumer. */
export function validateArtifactProvenance(value: unknown, expected: {
  readonly repositorySlug: string; readonly eventName: string; readonly pullRequestNumber: number; readonly headSha: string;
}): CiReviewArtifact {
  const parsed = CiReviewArtifactSchema.safeParse(value);
  if (!parsed.success) throw new Error('Artifact failed runtime schema validation');
  const artifact = parsed.data;
  if (artifact.context.repositorySlug.toLowerCase() !== expected.repositorySlug.toLowerCase()
    || artifact.context.eventName !== expected.eventName
    || artifact.context.pullRequestNumber !== expected.pullRequestNumber
    || artifact.context.headSha !== FullShaSchema.parse(expected.headSha)
    || artifact.review.scope.headSha !== FullShaSchema.parse(expected.headSha)) {
    throw new Error('Artifact provenance does not match the trusted workflow context');
  }
  return artifact;
}
