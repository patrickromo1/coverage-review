import { z } from 'zod';
import { proposalSchema, ReviewLimitsSchema } from '../../agent/review-agent.js';
import { EvidenceReferenceSchema } from './references.js';

export const LimitationSchema = z.strictObject({
  code: z.enum(['evidence-unavailable', 'evidence-incomplete', 'coverage-uncertain', 'discovery-incomplete',
    'agent-failure', 'invalid-proposal', 'timeout', 'agent-incomplete', 'scope-incomplete', 'finding-rejected']),
  message: z.string().min(1),
  file: z.string().optional(),
});
export type Limitation = z.infer<typeof LimitationSchema>;
export const ReviewResultSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  summary: z.string().min(1).max(100_000),
  findings: z.array(proposalSchema(ReviewLimitsSchema.parse({ maxFindings: 1_000, maxTextLength: 100_000 })).shape.findings.element),
  verdict: z.enum(['adequate', 'needs-tests', 'needs-review']),
  analysisStatus: z.enum(['complete', 'partial', 'failed']),
  scope: z.strictObject({
    baseSha: z.string().min(1), headSha: z.string().min(1),
    resolved: z.boolean(), changedFiles: z.array(z.string()), reviewedFiles: z.array(z.string()),
  }),
  limitations: z.array(LimitationSchema),
  rejectedFindings: z.array(z.strictObject({ index: z.number().int().nonnegative(), reason: z.string().min(1) })),
  evidenceReferences: z.array(EvidenceReferenceSchema),
  provenance: z.strictObject({
    executorVersion: z.literal('1'), policyVersion: z.literal('1'), evidenceSchemaVersion: z.literal('1'),
    agentMode: z.enum(['scripted', 'provider']), limits: ReviewLimitsSchema,
  }),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
