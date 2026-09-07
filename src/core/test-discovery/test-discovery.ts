import type { Repository } from '../repository/repository.js';

export type TestLevel = 'unit' | 'integration' | 'e2e' | 'unknown';
export type RelationshipSignal =
  | { readonly type: 'static-import'; readonly sourcePath: string }
  | { readonly type: 'matching-name'; readonly sourcePath: string }
  | { readonly type: 'co-located'; readonly sourcePath: string }
  | { readonly type: 'test-location'; readonly location: string };

export interface CandidateTest {
  readonly path: string;
  readonly level: TestLevel;
  readonly relationships: readonly RelationshipSignal[];
  readonly uncertainty: readonly string[];
}

export interface TestDiscoveryResult {
  readonly status: 'available' | 'truncated' | 'unsupported';
  readonly candidates: readonly CandidateTest[];
  readonly diagnostics: readonly string[];
}

export interface TestDiscoveryRequest {
  readonly repository: Repository;
  readonly headSha: string;
  readonly signal?: AbortSignal;
  readonly sourcePaths: readonly string[];
}

export interface TestDiscovery {
  discover(request: TestDiscoveryRequest): Promise<TestDiscoveryResult>;
}
