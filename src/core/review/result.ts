import { z } from 'zod';
import { proposalSchema, ReviewLimitsSchema } from '../../agent/review-agent.js';
import { EvidenceReferenceSchema } from './references.js';
import { assertRepositoryPath } from '../repository/repository.js';

const repositoryPath = z.string().refine((value) => {
  try { assertRepositoryPath(value); return true; } catch { return false; }
}, 'Expected a repository-relative path');

export const LimitationSchema = z.strictObject({
  code: z.enum(['evidence-unavailable', 'evidence-incomplete', 'coverage-uncertain', 'discovery-incomplete',
    'authentication', 'rate-limit', 'provider-error', 'refusal', 'budget-exhausted', 'agent-failure', 'invalid-proposal', 'timeout', 'agent-incomplete', 'scope-incomplete', 'finding-rejected']),
  message: z.string().min(1),
  file: repositoryPath.optional(),
});
export type Limitation = z.infer<typeof LimitationSchema>;
export const ReviewResultSchema = z.strictObject({
  schemaVersion: z.enum(['1', '2']),
  summary: z.string().min(1).max(100_000),
  findings: z.array(proposalSchema(ReviewLimitsSchema.parse({ maxFindings: 1_000, maxTextLength: 100_000 })).shape.findings.element),
  verdict: z.enum(['adequate', 'needs-tests', 'needs-review']),
  analysisStatus: z.enum(['complete', 'partial', 'failed']),
  scope: z.strictObject({
    baseSha: z.string().min(1), headSha: z.string().min(1),
    evidenceScope: z.strictObject({ collectedFiles: z.array(repositoryPath), omittedFiles: z.array(repositoryPath),
      unavailableFiles: z.array(repositoryPath), truncatedFiles: z.array(repositoryPath) }).optional(),
    resolved: z.boolean(), changedFiles: z.array(repositoryPath), reviewedFiles: z.array(repositoryPath),
    files: z.array(z.strictObject({
      path: repositoryPath, previousPath: repositoryPath.optional(),
      status: z.enum(['added', 'modified', 'deleted', 'renamed', 'type-changed']),
    })).default([]),
  }),
  limitations: z.array(LimitationSchema),
  rejectedFindings: z.array(z.strictObject({ index: z.number().int().nonnegative(), reason: z.string().min(1) })),
  evidenceReferences: z.array(EvidenceReferenceSchema),
  provenance: z.strictObject({
    executorVersion: z.enum(['1', '2']), policyVersion: z.enum(['1', '2']), evidenceSchemaVersion: z.enum(['1', '2']),
    agentMode: z.enum(['scripted', 'provider', 'none']),
    executionMode: z.enum(['local', 'github']).default('local'), snapshotMode: z.enum(['staged', 'unstaged']).optional(), limits: ReviewLimitsSchema,
  }),
}).superRefine((result, context) => {
  if (result.provenance.evidenceSchemaVersion !== result.schemaVersion || result.evidenceReferences.some((ref) => !ref.id.startsWith(`ev${result.schemaVersion}:`))) context.addIssue({ code: 'custom', message: 'Evidence identity version does not match result schema' });
  const local = result.scope.baseSha.startsWith('local:') || result.scope.headSha.startsWith('local:');
  if ((result.schemaVersion === '1' && (local || result.provenance.snapshotMode)) ||
      (result.schemaVersion === '2' && (!result.provenance.snapshotMode || result.provenance.executionMode !== 'local')) ||
      (result.schemaVersion === '2' && result.scope.resolved && (!/^local:[a-f0-9]{64}$/.test(result.scope.headSha) ||
        !(result.provenance.snapshotMode === 'staged' ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/ : /^local:[a-f0-9]{64}$/).test(result.scope.baseSha)))) {
    context.addIssue({ code: 'custom', message: 'Invalid snapshot identity or schema version' });
  }
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
