import type { ReviewAgentRequest, ReviewProposal } from '../../src/agent/review-agent.js';
import type { EvidenceCollectorDependencies } from '../../src/core/evidence/collect-evidence.js';

export function dependencies(): EvidenceCollectorDependencies {
  return {
    diff: {
      compare: async () => ({ baseSha: 'base', headSha: 'head', files: [{ path: 'a.ts', status: 'modified' }] }),
      getFileDiff: async () => '@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n',
    },
    repository: {
      listFiles: async () => ({ status: 'available', paths: ['a.ts', 'tests/unit/a.test.ts'] }),
      readSource: async () => ({ status: 'available', content: 'export const a = 2;' }),
    },
    testDiscovery: { discover: async () => ({ status: 'available', diagnostics: [], candidates: [{
      path: 'tests/unit/a.test.ts', level: 'unit', relationships: [{ type: 'static-import', sourcePath: 'a.ts' }],
      uncertainty: ['Candidate relationship does not prove that changed behavior is asserted'],
    }] }) },
    coverage: { getCoverage: async () => ({
      status: 'available', provenance: { format: 'lcov', reportPath: '/private/report', commitSha: 'head', freshness: 'matching' },
      diagnostics: [], files: [{ path: 'a.ts', lines: [{ line: 1, hits: 1, covered: true }], branches: [] }],
    }) },
  };
}
export function proposal(request: ReviewAgentRequest, withFinding = false): ReviewProposal {
  return {
    schemaVersion: '1', summary: 'Scripted fixture review.', analysisStatus: 'complete',
    reviewedFiles: request.evidence.files.map((file) => file.path), limitations: [],
    findings: withFinding ? [{
      file: 'a.ts', line: 1, side: 'head', severity: 'medium', description: 'Missing boundary assertion.',
      existingCoverage: { status: 'partial', description: 'Existing test exercises only the common case.', testFiles: [] },
      suggestedTestLevel: 'unit', reasoning: 'The boundary can be asserted in isolation.',
      suggestedTests: [{ description: 'Exercise the boundary.', expectedOutcome: 'The boundary value is returned.' }],
      evidenceRefs: request.references.filter((ref) => ref.file === 'a.ts' && ref.kind === 'diff').map((ref) => ref.id),
    }] : [],
  };
}
