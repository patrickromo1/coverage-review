import type { ReviewProposal } from '../../agent/review-agent.js';
import type { CoverageEvidence } from '../evidence/schema.js';
import { isTypeScriptOrJavaScript } from '../test-discovery/typescript-test-discovery.js';
import type { EvidenceReference } from './references.js';
import type { Limitation, ReviewResult } from './result.js';

export function evidenceLimitations(evidence: CoverageEvidence): Limitation[] {
  const result: Limitation[] = [];
  const add = (code: Limitation['code'], message: string, file?: string) => result.push({ code, message, ...(file ? { file } : {}) });
  if (evidence.diagnostics.length) add('evidence-incomplete', 'Evidence collection reported diagnostics.');
  if (evidence.testDiscovery.status !== 'available' || evidence.testDiscovery.diagnostics.length) {
    add('discovery-incomplete', 'Test discovery is incomplete or reported diagnostics.');
  }
  if (evidence.coverageReport.status !== 'available') add('evidence-unavailable', `Coverage report is ${evidence.coverageReport.status}.`);
  else if (evidence.coverageReport.provenance.freshness !== 'matching' || evidence.coverageReport.diagnostics.length) {
    add('coverage-uncertain', 'Coverage report is stale, unverifiable, or reported diagnostics.');
  }
  for (const file of evidence.files) {
    if (file.source.status !== 'available' || !isTypeScriptOrJavaScript(file.path) || file.diff.status !== 'available' || file.diff.binary) {
      add('evidence-incomplete', 'Source or diff is missing, unsupported, binary, or truncated.', file.path);
    }
    if (file.coverage.status === 'missing' || file.coverage.status === 'unknown' ||
      (file.coverage.status === 'measured' && (file.coverage.freshness !== 'matching' ||
        file.coverage.lines.some((line) => !line.covered) || file.coverage.branches.some((branch) => branch.covered !== true) ||
        (file.diff.status === 'available' && file.diff.headChangedLines.some((range) =>
          file.coverage.status === 'measured' && new Set(file.coverage.lines.filter((line) => line.line >= range.start && line.line <= range.end).map((line) => line.line)).size !== range.end - range.start + 1))))) {
      add('coverage-uncertain', 'Changed-line coverage is missing, uncertain, or contains uncovered behavior.', file.path);
    }
    if (file.candidateTests.some((test) => test.uncertainty.some((message) => message !== 'Candidate relationship does not prove that changed behavior is asserted'))) {
      add('discovery-incomplete', 'Candidate test relationships include additional uncertainty.', file.path);
    }
    if (file.candidateTests.length > 0 && file.candidateTests.every((test) => test.level === 'e2e' || test.level === 'unknown')) {
      add('discovery-incomplete', 'Only E2E or unclassified candidate tests were discovered.', file.path);
    }
  }
  return result;
}

export function rejectionReason(finding: ReviewProposal['findings'][number], evidence: CoverageEvidence, refs: readonly EvidenceReference[]): string | undefined {
  // Canonical changed path identifies renames; side selects the old or new location.
  const file = evidence.files.find((entry) => entry.path === finding.file);
  if (!file) return 'Finding does not identify a changed file.';
  if ((file.status === 'added' && finding.side === 'base') || (file.status === 'deleted' && finding.side === 'head')) return 'Location side does not exist.';
  if (file.diff.status !== 'available' || file.diff.binary) return 'Location cannot be validated against an available text diff.';
  const ranges = finding.side === 'base' ? file.diff.baseChangedLines : file.diff.headChangedLines;
  if (!ranges.some((range) => finding.line >= range.start && finding.line <= range.end)) return 'Location is not a changed line on the selected side.';
  const references = finding.evidenceRefs.map((id) => refs.find((ref) => ref.id === id));
  if (references.some((ref) => !ref || ref.file !== file.path) || !references.some((ref) => ref?.kind === 'diff')) return 'Evidence references must exist, belong to this file, and include its diff.';
  if (finding.existingCoverage.testFiles.some((path) => !file.candidateTests.some((test) => test.path === path))) return 'Cited test file is not a discovered candidate for this change.';
  if (finding.suggestedTestLevel !== 'unit' && !finding.lowerLevelReason) return 'Integration and E2E recommendations must explain why a lower test level is insufficient.';
  return undefined;
}

export function verdictFor(findings: number, status: ReviewResult['analysisStatus']): ReviewResult['verdict'] {
  return findings > 0 ? 'needs-tests' : status === 'complete' ? 'adequate' : 'needs-review';
}
