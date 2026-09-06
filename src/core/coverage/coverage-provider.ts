export interface CoverageProvenance {
  readonly format: 'lcov' | 'coverage-py-json' | 'multiple';
  readonly reportPath: string;
  readonly commitSha?: string;
  readonly freshness: 'matching' | 'stale' | 'unverifiable';
}

export interface LineCoverage {
  readonly line: number;
  readonly hits: number;
  readonly covered: boolean;
}

export interface BranchCoverage {
  readonly line: number;
  readonly block: string;
  readonly branch: string;
  readonly hits: number | null;
  readonly covered: boolean | null;
}

export interface FileCoverage {
  readonly path: string;
  readonly lines: readonly LineCoverage[];
  readonly branches: readonly BranchCoverage[];
}

export interface CoverageReportSummary {
  readonly format: 'lcov' | 'coverage-py-json';
  readonly root?: string;
  readonly commitSha?: string;
  readonly freshness: CoverageProvenance['freshness'];
  readonly status: 'available' | 'unsupported' | 'truncated' | 'unavailable';
  readonly diagnostics: readonly string[];
  readonly bytes: number;
  readonly digest?: string;
}
export type CoverageResult =
  | { readonly status: 'available'; readonly provenance: CoverageProvenance; readonly files: readonly FileCoverage[]; readonly diagnostics: readonly string[]; readonly reports?: readonly CoverageReportSummary[] }
  | { readonly status: 'unavailable' | 'unsupported' | 'truncated'; readonly reason: string; readonly provenance?: CoverageProvenance; readonly reports?: readonly CoverageReportSummary[] };

export interface CoverageRequest { readonly headSha: string; readonly signal?: AbortSignal }

export interface CoverageProvider {
  getCoverage(request: CoverageRequest): Promise<CoverageResult>;
}
