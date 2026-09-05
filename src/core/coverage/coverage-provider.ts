export interface CoverageProvenance {
  readonly format: 'lcov';
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

export type CoverageResult =
  | { readonly status: 'available'; readonly provenance: CoverageProvenance; readonly files: readonly FileCoverage[]; readonly diagnostics: readonly string[] }
  | { readonly status: 'unavailable' | 'unsupported' | 'truncated'; readonly reason: string; readonly provenance?: CoverageProvenance };

export interface CoverageRequest { readonly headSha: string }

export interface CoverageProvider {
  getCoverage(request: CoverageRequest): Promise<CoverageResult>;
}
