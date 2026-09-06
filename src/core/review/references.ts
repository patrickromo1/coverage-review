import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CoverageEvidence } from '../evidence/schema.js';

export const EvidenceReferenceSchema = z.strictObject({
  id: z.string().regex(/^ev[12]:[a-f0-9]{64}$/),
  file: z.string().min(1),
  kind: z.enum(['diff', 'source', 'tests', 'coverage']),
});
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

/** Content-addressed references bind each evidence fragment to the resolved comparison. */
export function evidenceReferences(evidence: CoverageEvidence): EvidenceReference[] {
  return evidence.files.flatMap((file) => (['diff', 'source', 'tests', 'coverage'] as const).map((kind) => ({
    id: `ev${evidence.schemaVersion}:${createHash('sha256').update(JSON.stringify([
      evidence.comparison, file.path, file.previousPath ?? null, file.status, kind,
      kind === 'tests' ? file.candidateTests : file[kind],
    ])).digest('hex')}`,
    file: file.path, kind,
  }))).sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
