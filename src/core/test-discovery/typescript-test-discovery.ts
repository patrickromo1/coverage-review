import { discoveryListing } from '../repository/repository.js';
import { packageFor, type ReviewConfig } from '../config/review-config.js';
import { extname, posix } from 'node:path';
import type { CandidateTest, RelationshipSignal, TestDiscovery, TestDiscoveryRequest, TestLevel } from './test-discovery.js';

const scriptExtension = /\.(?:[cm]?[jt]sx?)$/i;
const testName = /(?:^|\/)(?:__tests__\/.*|.*(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?|(?:test|tests)\/.*\.[cm]?[jt]sx?)$/i;

function withoutExtension(path: string): string {
  const extension = extname(path);
  return (extension ? path.slice(0, -extension.length) : path).replace(/\/index$/, '');
}

function levelFor(path: string): TestLevel {
  const segments = path.toLowerCase().split('/');
  if (segments.some((part) => part === 'e2e' || part === 'end-to-end') || /(?:\.|-)e2e\./i.test(path)) return 'e2e';
  if (segments.includes('integration') || /(?:\.|-)integration\./i.test(path)) return 'integration';
  if (segments.includes('unit') || /(?:\.|-)unit\./i.test(path)) return 'unit';
  return 'unknown';
}

function importedSpecifiers(content: string): string[] {
  const values: string[] = [];
  const patterns = [
    /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'";]+?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) if (match[1]) values.push(match[1]);
  }
  return values;
}

function resolveImport(testPath: string, specifier: string, sourcePaths: readonly string[]) {
  if (!specifier.startsWith('.')) return { paths: [] as string[], ambiguous: false };
  const resolved = posix.normalize(posix.join(posix.dirname(testPath), specifier));
  const exact = sourcePaths.filter((source) => source === resolved);
  if (exact.length > 0) return { paths: exact, ambiguous: false };
  const stem = withoutExtension(resolved);
  const paths = sourcePaths.filter((source) => withoutExtension(source) === stem);
  return { paths, ambiguous: paths.length > 1 };
}

function conventionalSignals(testPath: string, sourcePaths: readonly string[]): RelationshipSignal[] {
  const testStem = withoutExtension(testPath).replace(/(?:\.|-)(?:test|spec)$/, '');
  const signals: RelationshipSignal[] = [];
  for (const source of sourcePaths) {
    const sourceStem = withoutExtension(source);
    if (posix.basename(testStem) === posix.basename(sourceStem)) signals.push({ type: 'matching-name', sourcePath: source });
    if (posix.dirname(testPath) === posix.dirname(source)) signals.push({ type: 'co-located', sourcePath: source });
  }
  const location = testPath.split('/').find((part) => ['test', 'tests', '__tests__', 'unit', 'integration', 'e2e'].includes(part.toLowerCase()));
  if (location) signals.push({ type: 'test-location', location });
  return signals;
}

export class TypeScriptTestDiscovery implements TestDiscovery {
  constructor(private readonly maxCandidates = 2_000, private readonly config?: ReviewConfig) {
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 2000) throw new Error('Invalid candidate budget');
  }

  async discover({ repository, headSha, sourcePaths, signal }: TestDiscoveryRequest) {
    sourcePaths = sourcePaths.filter(isTypeScriptOrJavaScript);
    const sourcesOmitted = sourcePaths.length > 1000;
    sourcePaths = sourcePaths.slice(0, 1000);
    let relationshipCount = 0;
    const listing = await discoveryListing(repository, headSha, signal);
    const paths = listing.paths.filter((path) => scriptExtension.test(path) && testName.test(path));
    const diagnostics: string[] = [];
    let truncated = listing.status === 'truncated' || sourcesOmitted;
    if (sourcesOmitted) diagnostics.push('Discovery source-path budget exhausted');
    if (listing.reason) diagnostics.push(listing.reason);
    if (paths.length > this.maxCandidates) {
      paths.length = this.maxCandidates;
      truncated = true;
      diagnostics.push(`Test candidates exceed ${this.maxCandidates} file limit`);
    }
    const candidates: CandidateTest[] = [];
    for (const path of paths) {
      signal?.throwIfAborted();
      if (relationshipCount >= 20_000) { truncated = true; diagnostics.push('Discovery relationship budget exhausted'); break; }
      const signals = conventionalSignals(path, this.config ? sourcePaths.filter((source) => packageFor(source, this.config!) === packageFor(path, this.config!)) : sourcePaths);
      const uncertainty = ['Candidate relationship does not prove that changed behavior is asserted'];
      const read = await repository.readSource(headSha, path, signal);
      if (read.status === 'available') {
        const specifiers = importedSpecifiers(read.content);
        if (specifiers.length > 100) { truncated = true; diagnostics.push('Static import budget exhausted'); }
        for (const specifier of specifiers.slice(0, 100)) {
          if (!specifier.startsWith('.')) uncertainty.push('Non-relative import or alias was not resolved');
          const resolved = resolveImport(path, specifier, sourcePaths);
          for (const sourcePath of resolved.paths) {
            if (!signals.some((signal) => signal.type === 'static-import' && signal.sourcePath === sourcePath)) {
              signals.push({ type: 'static-import', sourcePath });
            }
          }
          if (resolved.ambiguous) {
            uncertainty.push(`Static import ${JSON.stringify(specifier)} ambiguously matches ${resolved.paths.join(', ')}`);
          }
        }
      } else {
        diagnostics.push(`Could not inspect ${path}: ${read.reason}`);
      }
      if (signals.length > Math.min(100, 20_000 - relationshipCount)) { signals.length = Math.min(100, 20_000 - relationshipCount); truncated = true; diagnostics.push('Per-candidate relationship budget exhausted'); }
      relationshipCount += signals.length;
      if (signals.some((signal) => 'sourcePath' in signal)) {
        candidates.push({
          path, level: levelFor(path), relationships: signals,
          uncertainty,
        });
      }
    }
    return { status: truncated ? 'truncated' as const : 'available' as const, candidates, diagnostics: [...new Set(diagnostics)] };
  }
}

export function isTypeScriptOrJavaScript(path: string): boolean {
  return scriptExtension.test(path);
}
