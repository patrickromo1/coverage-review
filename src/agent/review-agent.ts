import { z } from 'zod';
import { CoverageFindingSchema } from '../core/review/schema.js';
import type { CoverageEvidence } from '../core/evidence/schema.js';
import type { EvidenceReference } from '../core/review/references.js';

export const ReviewLimitsSchema = z.strictObject({
  maxFindings: z.number().int().min(1).max(1_000).default(50),
  maxTextLength: z.number().int().min(1).max(100_000).default(4_000),
  timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
});
export type ReviewLimits = z.infer<typeof ReviewLimitsSchema>;

export function proposalSchema(limits: ReviewLimits) {
  const text = z.string().trim().min(1).max(limits.maxTextLength);
  return z.strictObject({
    schemaVersion: z.literal('1'),
    summary: text,
    analysisStatus: z.enum(['complete', 'partial']),
    reviewedFiles: z.array(z.string().min(1).max(limits.maxTextLength)).max(10_000),
    limitations: z.array(text).max(50),
    findings: z.array(CoverageFindingSchema.extend({
      file: CoverageFindingSchema.shape.file.refine((value) => value.length <= limits.maxTextLength),
      line: z.number().int().positive(),
      description: text,
      reasoning: text,
      existingCoverage: CoverageFindingSchema.shape.existingCoverage.extend({
        description: text, testFiles: z.array(z.string().min(1).max(limits.maxTextLength)).max(100),
      }),
      suggestedTests: z.array(z.strictObject({ description: text, expectedOutcome: text })).min(1).max(20),
      evidenceRefs: z.array(z.string().min(1).max(100)).min(1).max(20),
      lowerLevelReason: text.optional(),
    })).max(limits.maxFindings),
  });
}
export const ReviewProposalSchema = proposalSchema(ReviewLimitsSchema.parse({}));
export type ReviewProposal = z.infer<typeof ReviewProposalSchema>;
export interface ReviewAgentRequest {
  readonly evidence: CoverageEvidence;
  readonly references: readonly EvidenceReference[];
  readonly limits: ReviewLimits;
  readonly signal: AbortSignal;
}
/** Untrusted proposal only. No verdict, repository tools, or provider SDK types. */
export interface ReviewAgent {
  readonly mode: 'scripted' | 'provider';
  propose(request: ReviewAgentRequest): Promise<unknown>;
}
