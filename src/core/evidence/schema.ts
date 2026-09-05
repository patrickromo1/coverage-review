import { z } from 'zod';
import { assertRepositoryPath } from '../repository/repository.js';

const path = z.string().refine((value) => {
  try { assertRepositoryPath(value); return true; } catch { return false; }
}, 'Expected a repository-relative path');
const range = z.strictObject({ start: z.number().int().positive(), end: z.number().int().positive() });
const changeStatus = z.enum(['added', 'modified', 'deleted', 'renamed', 'type-changed']);
const sourceStatus = z.enum(['available', 'missing', 'binary', 'truncated', 'unsupported']);

const relationship = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('static-import'), sourcePath: path }),
  z.strictObject({ type: z.literal('matching-name'), sourcePath: path }),
  z.strictObject({ type: z.literal('co-located'), sourcePath: path }),
  z.strictObject({ type: z.literal('test-location'), location: z.string().min(1) }),
]);

const provenance = z.strictObject({
  format: z.literal('lcov'), reportPath: z.string().min(1), commitSha: z.string().min(1).optional(),
  freshness: z.enum(['matching', 'stale', 'unverifiable']),
});

export const CoverageEvidenceSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  comparison: z.strictObject({ baseSha: z.string().min(1), headSha: z.string().min(1) }),
  testDiscovery: z.strictObject({
    status: z.enum(['available', 'truncated', 'unsupported']), diagnostics: z.array(z.string()),
  }),
  coverageReport: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available'), provenance, diagnostics: z.array(z.string()) }),
    z.strictObject({ status: z.enum(['unavailable', 'unsupported', 'truncated']), reason: z.string().min(1), provenance: provenance.optional() }),
  ]),
  files: z.array(z.strictObject({
    path,
    status: changeStatus,
    previousPath: path.optional(),
    diff: z.discriminatedUnion('status', [
      z.strictObject({
        status: z.literal('available'), binary: z.boolean(), baseChangedLines: z.array(range), headChangedLines: z.array(range),
        hunks: z.array(z.strictObject({
          base: z.strictObject({ start: z.number().int().nonnegative(), count: z.number().int().nonnegative() }),
          head: z.strictObject({ start: z.number().int().nonnegative(), count: z.number().int().nonnegative() }),
          section: z.string().optional(),
          lines: z.array(z.strictObject({
            kind: z.enum(['context', 'addition', 'deletion']), content: z.string(),
            baseLine: z.number().int().positive().optional(), headLine: z.number().int().positive().optional(),
          })),
        })),
      }),
      z.strictObject({ status: z.enum(['unsupported', 'truncated']), reason: z.string().min(1) }),
    ]),
    source: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('available'), side: z.enum(['base', 'head']) }),
      z.strictObject({ status: sourceStatus.exclude(['available']), side: z.enum(['base', 'head']), reason: z.string().min(1) }),
    ]),
    candidateTests: z.array(z.strictObject({
      path, level: z.enum(['unit', 'integration', 'e2e', 'unknown']), relationships: z.array(relationship),
      uncertainty: z.array(z.string().min(1)),
    })),
    coverage: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('measured'), freshness: z.enum(['matching', 'stale', 'unverifiable']), lines: z.array(z.strictObject({ line: z.number().int().positive(), hits: z.number().int().nonnegative(), covered: z.boolean() })), branches: z.array(z.strictObject({ line: z.number().int().positive(), block: z.string(), branch: z.string(), hits: z.number().int().nonnegative().nullable(), covered: z.boolean().nullable() })) }),
      z.strictObject({ status: z.enum(['missing', 'unknown', 'not-applicable']), reason: z.string().min(1) }),
    ]),
  })),
  diagnostics: z.array(z.string()),
});

export type CoverageEvidence = z.infer<typeof CoverageEvidenceSchema>;
