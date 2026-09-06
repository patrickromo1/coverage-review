import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { CoverageProvider, CoverageRequest, CoverageReportSummary, CoverageResult, FileCoverage } from '../../core/coverage/coverage-provider.js';
import { ReviewConfigSchema, type ReviewConfig } from '../../core/config/review-config.js';
import { parseLcov } from '../../core/coverage/parse-lcov.js';
import { parseCoveragePy } from '../../core/coverage/parse-coverage-py.js';
import { assertRepositoryPath } from '../../core/repository/repository.js';
import { readBoundedFile } from '../files/bounded-file.js';

export class MultipleCoverageProvider implements CoverageProvider {
  private readonly reports: ReviewConfig['reports'];
  constructor(private readonly root: string, reports: ReviewConfig['reports']) {
    this.reports = ReviewConfigSchema.parse({ schemaVersion: '1', reports }).reports;
  }
  async getCoverage({ headSha, signal }: CoverageRequest): Promise<CoverageResult> {
    signal?.throwIfAborted();
    const reports: CoverageReportSummary[] = [];
    const files = new Map<string, FileCoverage>();
    const seen = new Set<string>();
    const conflicts = new Set<string>();
    const diagnostics: string[] = [];
    let remainingRecords = 200_000;
    let remaining = 32 * 1024 * 1024;
    for (const input of this.reports) {
      signal?.throwIfAborted();
      const freshness = headSha.startsWith('local:') || !input.commitSha ? 'unverifiable' : input.commitSha.toLowerCase() === headSha.toLowerCase() ? 'matching' : 'stale';
      const summary = { format: input.format, ...(input.commitSha ? { commitSha: input.commitSha } : {}), ...(input.root ? { root: input.root } : {}), freshness, bytes: 0 } as const;
      if (remaining <= 0) { reports.push({ ...summary, status: 'truncated', diagnostics: ['Aggregate coverage byte budget exhausted'] }); continue; }
      const reservation = Math.min(16 * 1024 * 1024, remaining);
      let reportBytes = 0;
      try {
        const buffer = await readBoundedFile(this.root, input.path, reservation, signal);
        reportBytes = buffer.length;
        remaining -= buffer.length;
        const digest = createHash('sha256').update(buffer).digest('hex');
        const key = JSON.stringify([digest, input.root, input.format, input.commitSha]);
        if (seen.has(key)) { reports.push({ ...summary, status: 'available', bytes: buffer.length, digest, diagnostics: ['Duplicate report ignored'] }); continue; }
        const parsed = input.format === 'lcov' ? { files: parseLcov(buffer.toString('utf8'), resolve(this.root, input.root ?? '')), diagnostics: [] } : parseCoveragePy(buffer.toString('utf8'));
        const records = parsed.files.reduce((total, file) => total + 1 + file.lines.length + file.branches.length, 0);
        if (records > remainingRecords) throw new Error('Aggregate coverage record budget exhausted');
        remainingRecords -= records;
        for (const file of parsed.files) {
          const path = input.root ? `${input.root}/${file.path}` : file.path;
          assertRepositoryPath(path);
          const previous = files.get(path);
          const mapped = { ...file, path };
          // Exact duplicate measurements are idempotent. Any different overlap stays uncertain.
          if (previous && JSON.stringify(previous) !== JSON.stringify(mapped)) { conflicts.add(path); files.delete(path); diagnostics.push('Overlapping coverage measurements conflict'); }
          else if (!previous && !conflicts.has(path)) files.set(path, mapped);
        }
        seen.add(key);
        reports.push({ ...summary, status: 'available', bytes: buffer.length, digest, diagnostics: parsed.diagnostics });
      } catch (error) {
        signal?.throwIfAborted();
        const budget = error instanceof Error && /budget/.test(error.message);
        // A failed read consumes its reservation; repeated failing reports cannot bypass aggregate limits.
        remaining -= reservation - reportBytes;
        reports.push({ ...summary, bytes: reportBytes, status: budget ? 'truncated' : 'unsupported', diagnostics: [budget ? 'Coverage budget exhausted' : 'Coverage input invalid, unavailable, or unsafe'] });
      }
    }
    if (!reports.length) return { status: 'unavailable', reason: 'No coverage reports provided', reports };
    for (const report of reports) {
      if (report.status !== 'available' || report.freshness !== 'matching' || report.diagnostics.some((value) => value !== 'Duplicate report ignored')) diagnostics.push('Report incomplete, stale, unverifiable, or diagnostic');
    }
    const freshness = reports.some((report) => report.freshness === 'stale') ? 'stale' : reports.some((report) => report.freshness === 'unverifiable') ? 'unverifiable' : 'matching';
    return { status: 'available', provenance: { format: 'multiple', reportPath: 'configured-reports', freshness },
      files: [...files.values()].sort((a, b) => a.path < b.path ? -1 : 1), reports, diagnostics: [...new Set(diagnostics)] };
  }
}
