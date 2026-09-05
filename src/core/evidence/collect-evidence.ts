import type { CoverageProvider, CoverageResult } from '../coverage/coverage-provider.js';
import type { DiffProvider } from '../diff/diff-provider.js';
import { parseUnifiedDiff, type LineRange } from '../diff/structured-diff.js';
import type { Repository, SourceRead } from '../repository/repository.js';
import type { TestDiscovery, TestDiscoveryResult } from '../test-discovery/test-discovery.js';
import { isTypeScriptOrJavaScript } from '../test-discovery/typescript-test-discovery.js';
import { CoverageEvidenceSchema, type CoverageEvidence } from './schema.js';

export interface EvidenceCollectorDependencies {
  readonly diff: DiffProvider;
  readonly repository: Repository;
  readonly testDiscovery: TestDiscovery;
  readonly coverage: CoverageProvider;
}

function includesLine(ranges: readonly LineRange[], line: number): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function sourceEvidence(read: SourceRead, side: 'base' | 'head') {
  return read.status === 'available'
    ? { status: 'available' as const, side }
    : { status: read.status, side, reason: read.reason };
}

function reportSummary(result: CoverageResult): CoverageEvidence['coverageReport'] {
  if (result.status === 'available') return { status: 'available', provenance: result.provenance, diagnostics: [...result.diagnostics] };
  return { status: result.status, reason: result.reason, ...result.provenance ? { provenance: result.provenance } : {} };
}

function unknownCoverage(result: CoverageResult): { status: 'unknown'; reason: string } {
  return { status: 'unknown', reason: result.status === 'available' ? 'Coverage file was not measured by the report' : result.reason };
}

function relevantCandidates(result: TestDiscoveryResult, paths: readonly string[]) {
  return result.candidates
    .filter((candidate) => candidate.relationships.some(
      (signal) => 'sourcePath' in signal && paths.includes(signal.sourcePath),
    ))
    .map((candidate) => ({
      ...candidate, relationships: [...candidate.relationships], uncertainty: [...candidate.uncertainty],
    }));
}

export async function collectEvidence(
  baseSha: string,
  headSha: string,
  dependencies: EvidenceCollectorDependencies,
): Promise<CoverageEvidence> {
  const comparison = await dependencies.diff.compare(baseSha, headSha);
  const sourcePaths = [...new Set(comparison.files.flatMap((file) =>
    [file.path, ...(file.previousPath ? [file.previousPath] : [])].filter(isTypeScriptOrJavaScript),
  ))];
  let tests: TestDiscoveryResult;
  try {
    tests = await dependencies.testDiscovery.discover({ repository: dependencies.repository, headSha: comparison.headSha, sourcePaths });
  } catch (error) {
    tests = { status: 'unsupported', candidates: [], diagnostics: [error instanceof Error ? error.message : String(error)] };
  }
  let coverage: CoverageResult;
  try {
    coverage = await dependencies.coverage.getCoverage({ headSha: comparison.headSha });
  } catch (error) {
    coverage = { status: 'unsupported', reason: error instanceof Error ? error.message : String(error) };
  }
  const diagnostics: string[] = [];
  const files: CoverageEvidence['files'][number][] = [];
  for (const file of comparison.files) {
    const relationshipPaths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
    const side = file.status === 'deleted' ? 'base' as const : 'head' as const;
    const commit = side === 'base' ? comparison.baseSha : comparison.headSha;
    let read: SourceRead;
    try {
      read = await dependencies.repository.readSource(commit, side === 'base' ? file.previousPath ?? file.path : file.path);
    } catch (error) {
      read = { status: 'unsupported', reason: error instanceof Error ? error.message : String(error) };
    }
    let structured;
    try {
      structured = parseUnifiedDiff(await dependencies.diff.getFileDiff(comparison.baseSha, comparison.headSha, file.path), file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /maxBuffer|too large|truncat/i.test(message) ? 'truncated' as const : 'unsupported' as const;
      diagnostics.push(`${file.path}: ${message}`);
      files.push({
        ...file, diff: { status, reason: message }, source: sourceEvidence(read, side),
        candidateTests: relevantCandidates(tests, relationshipPaths), coverage: unknownCoverage(coverage),
      });
      continue;
    }
    const measured = coverage.status === 'available' ? coverage.files.find((entry) => entry.path === file.path) : undefined;
    const fileCoverage = file.status === 'deleted' || structured.binary
      ? { status: 'not-applicable' as const, reason: file.status === 'deleted' ? 'Deleted files have no head coverage' : 'Binary changes have no line coverage' }
      : measured
        ? {
            status: 'measured' as const, freshness: coverage.status === 'available' ? coverage.provenance.freshness : 'unverifiable' as const,
            lines: measured.lines.filter((line) => includesLine(structured.headChangedLines, line.line)).map((line) => ({ ...line })),
            branches: measured.branches.filter((branch) => includesLine(structured.headChangedLines, branch.line)).map((branch) => ({ ...branch })),
          }
        : coverage.status === 'available'
          ? { status: 'missing' as const, reason: 'File is absent from the coverage report' }
          : unknownCoverage(coverage);
    files.push({
      ...file,
      diff: {
        status: 'available', binary: structured.binary,
        hunks: structured.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => ({ ...line })) })),
        baseChangedLines: structured.baseChangedLines.map((range) => ({ ...range })),
        headChangedLines: structured.headChangedLines.map((range) => ({ ...range })),
      },
      source: sourceEvidence(read, side), candidateTests: relevantCandidates(tests, relationshipPaths), coverage: fileCoverage,
    });
  }
  return CoverageEvidenceSchema.parse({
    schemaVersion: '1', comparison: { baseSha: comparison.baseSha, headSha: comparison.headSha },
    testDiscovery: { status: tests.status, diagnostics: [...tests.diagnostics] }, coverageReport: reportSummary(coverage), files, diagnostics,
  });
}
