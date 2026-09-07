import { ReviewRepository } from '../repository/review-repository.js';
import type { ReviewTrace } from '../review/trace.js';
import type { CoverageProvider, CoverageResult } from '../coverage/coverage-provider.js';
import type { DiffProvider } from '../diff/diff-provider.js';
import { parseUnifiedDiff, type LineRange } from '../diff/structured-diff.js';
import type { Repository, SourceRead } from '../repository/repository.js';
import type { TestDiscovery, TestDiscoveryResult } from '../test-discovery/test-discovery.js';
import { isSupportedSource } from '../test-discovery/supported-test-discovery.js';
import { CoverageEvidenceSchema, type CoverageEvidence } from './schema.js';

export interface EvidenceCollectorDependencies {
  readonly captureLocal?: (mode: 'staged' | 'unstaged', signal: AbortSignal) => Promise<{ baseSha: string; headSha: string; diff: DiffProvider; repository: Repository; metrics?: { requests: number; readBytes: number; filesScanned: number } }>;
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
  const reports = result.reports ? { reports: result.reports.map((report) => ({ ...report, diagnostics: [...report.diagnostics] })) } : {};
  if (result.status === 'available') return { ...reports, status: 'available', provenance: result.provenance, diagnostics: [...result.diagnostics] };
  return { ...reports, status: result.status, reason: result.reason, ...result.provenance ? { provenance: result.provenance } : {} };
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
      ...candidate, relationships: candidate.relationships.filter((relationship) => !('sourcePath' in relationship) || paths.includes(relationship.sourcePath)), uncertainty: [...candidate.uncertainty],
    }));
}

export async function collectEvidence(
  baseSha: string,
  headSha: string,
  dependencies: EvidenceCollectorDependencies,
  signal?: AbortSignal,
  trace?: ReviewTrace,
): Promise<CoverageEvidence> {
  signal?.throwIfAborted();
  const comparison = await dependencies.diff.compare(baseSha, headSha, signal);
  if (!(dependencies.repository instanceof ReviewRepository)) dependencies = { ...dependencies, repository: new ReviewRepository(dependencies.repository, [comparison.baseSha, comparison.headSha]) };
  const sourcePaths = [...new Set(comparison.files.flatMap((file) =>
    [file.path, ...(file.previousPath ? [file.previousPath] : [])].filter(isSupportedSource),
  ))];
  const discoveryStarted = Date.now();
  let tests: TestDiscoveryResult;
  try {
    tests = await dependencies.testDiscovery.discover({ repository: dependencies.repository, headSha: comparison.headSha, sourcePaths, ...(signal ? { signal } : {}) });
  } catch (error) {
    tests = { status: 'unsupported', candidates: [], diagnostics: [error instanceof Error ? error.message : String(error)] };
  }
  signal?.throwIfAborted();
  await trace?.emit('discovery', discoveryStarted, tests.status === 'available' && !tests.diagnostics.length ? 'ok' : 'partial', { files: tests.candidates.length });
  const coverageStarted = Date.now();
  let coverage: CoverageResult;
  try {
    coverage = await dependencies.coverage.getCoverage({ headSha: comparison.headSha, ...(signal ? { signal } : {}) });
  } catch (error) {
    coverage = { status: 'unsupported', reason: error instanceof Error ? error.message : String(error) };
  }
  signal?.throwIfAborted();
  if (comparison.headSha.startsWith('local:') && coverage.status === 'available') {
    coverage = { ...coverage, provenance: { ...coverage.provenance, freshness: 'unverifiable' }, diagnostics: [...coverage.diagnostics, 'Commit metadata cannot establish local snapshot coverage freshness'] };
  }
  await trace?.emit('coverage', coverageStarted, coverage.status === 'available' && !coverage.diagnostics.length ? 'ok' : 'partial', { files: coverage.status === 'available' ? coverage.files.length : 0, readBytes: coverage.reports?.reduce((total, report) => total + report.bytes, 0) ?? 0 });
  const diagnostics: string[] = [];
  const measuredFiles = new Map(coverage.status === 'available' ? coverage.files.map((file) => [file.path, file]) : []);
  let patchBytes = 0;
  let processed = 0;
  const files: CoverageEvidence['files'][number][] = [];
  for (const file of comparison.files) {
    signal?.throwIfAborted();
    if (++processed > 500 || patchBytes >= 16 * 1024 * 1024) {
      files.push({ ...file, diff: { status: 'truncated', reason: 'Collection file or patch budget exhausted' },
        source: { status: 'truncated', side: file.status === 'deleted' ? 'base' : 'head', reason: 'File omitted by collection budget' },
        candidateTests: [], coverage: { status: 'unknown', reason: 'File omitted by collection budget' } });
      continue;
    }
    const relationshipPaths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
    const side = file.status === 'deleted' ? 'base' as const : 'head' as const;
    const commit = side === 'base' ? comparison.baseSha : comparison.headSha;
    let read: SourceRead;
    try {
      read = await dependencies.repository.readSource(commit, side === 'base' ? file.previousPath ?? file.path : file.path, signal);
    } catch (error) {
      read = { status: 'unsupported', reason: error instanceof Error ? error.message : String(error) };
    }
    let structured;
    try {
      const patch = await dependencies.diff.getFileDiff(comparison.baseSha, comparison.headSha, file.path, signal);
      patchBytes += Buffer.byteLength(patch);
      if (patchBytes > 16 * 1024 * 1024) throw new Error('Aggregate patch budget truncated');
      structured = parseUnifiedDiff(patch, file);
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
    const measured = measuredFiles.get(file.path);
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
    schemaVersion: comparison.headSha.startsWith('local:') ? '2' : '1', comparison: { baseSha: comparison.baseSha, headSha: comparison.headSha },
    testDiscovery: { status: tests.status, diagnostics: [...tests.diagnostics] }, coverageReport: reportSummary(coverage), files, diagnostics,
  });
}
