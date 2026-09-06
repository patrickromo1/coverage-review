import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import type { CoverageProvider, CoverageProvenance } from '../../core/coverage/coverage-provider.js';
import { parseLcov } from '../../core/coverage/parse-lcov.js';

export class LcovCoverageProvider implements CoverageProvider {
  constructor(
    private readonly repositoryRoot: string,
    private readonly reportPath: string,
    private readonly commitSha?: string,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
  }

  async getCoverage({ headSha, signal }: { readonly headSha: string; readonly signal?: AbortSignal }) {
    signal?.throwIfAborted();
    const freshness: CoverageProvenance['freshness'] = headSha.startsWith('local:') || this.commitSha === undefined
      ? 'unverifiable' : this.commitSha.toLowerCase() === headSha.toLowerCase() ? 'matching' : 'stale';
    const provenance: CoverageProvenance = {
      format: 'lcov', reportPath: resolve(this.reportPath), freshness,
      ...(this.commitSha === undefined ? {} : { commitSha: this.commitSha }),
    };
    let content: string;
    try {
      const pathStat = await lstat(this.reportPath);
      if (pathStat.isSymbolicLink()) return { status: 'unsupported' as const, reason: 'LCOV path must not be a symbolic link', provenance };
      if (!pathStat.isFile()) return { status: 'unsupported' as const, reason: 'LCOV path must be a regular file', provenance };
      const file = await open(this.reportPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const size = (await file.stat()).size;
        if (size > this.maxBytes) return { status: 'truncated' as const, reason: `LCOV exceeds ${this.maxBytes} byte limit`, provenance };
        const buffer = Buffer.alloc(this.maxBytes + 1);
        let total = 0;
        while (total < buffer.byteLength) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer, total, buffer.byteLength - total, null);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
        if (total > this.maxBytes) return { status: 'truncated' as const, reason: `LCOV exceeds ${this.maxBytes} byte limit`, provenance };
        content = buffer.subarray(0, total).toString('utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      return { status: 'unavailable' as const, reason: error instanceof Error ? error.message : String(error), provenance };
    }
    try {
      const files = parseLcov(content, this.repositoryRoot);
      const diagnostics = freshness === 'matching' ? [] : [freshness === 'stale'
        ? `Coverage commit ${this.commitSha} does not match reviewed head ${headSha}`
        : 'Coverage report has no verifiable commit metadata'];
      return { status: 'available' as const, provenance, files, diagnostics };
    } catch (error) {
      return { status: 'unsupported' as const, reason: error instanceof Error ? error.message : String(error), provenance };
    }
  }
}

export class UnavailableCoverageProvider implements CoverageProvider {
  async getCoverage() { return { status: 'unavailable' as const, reason: 'No coverage report was provided' }; }
}
