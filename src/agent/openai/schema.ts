import { z } from 'zod';
import { proposalSchema, type ReviewLimits } from '../review-agent.js';

/** Strict JSON output requires all keys: optional lowerLevelReason becomes nullable.
 * Refinements/defaults stay in the domain schema; this wire schema is deliberately plain. */
export const OpenAIProposalSchema = z.strictObject({
  schemaVersion: z.literal('1'), summary: z.string(), analysisStatus: z.enum(['complete', 'partial']),
  reviewedFiles: z.array(z.string()), limitations: z.array(z.string()),
  findings: z.array(z.strictObject({
    file: z.string(), line: z.number().int(), side: z.enum(['base', 'head']),
    severity: z.enum(['low', 'medium', 'high']), description: z.string(), reasoning: z.string(),
    existingCoverage: z.strictObject({ status: z.enum(['unknown', 'none', 'partial', 'covered']), description: z.string(), testFiles: z.array(z.string()) }),
    suggestedTestLevel: z.enum(['unit', 'integration', 'e2e']),
    suggestedTests: z.array(z.strictObject({ description: z.string(), expectedOutcome: z.string() })),
    evidenceRefs: z.array(z.string()), lowerLevelReason: z.string().nullable(),
  })),
});
export function mapOpenAIProposal(raw: unknown, limits: ReviewLimits) {
  const wire = OpenAIProposalSchema.parse(raw);
  return proposalSchema(limits).parse({ ...wire, findings: wire.findings.map(({ lowerLevelReason, ...finding }) => ({
    ...finding, ...(lowerLevelReason === null ? {} : { lowerLevelReason }),
  })) });
}
