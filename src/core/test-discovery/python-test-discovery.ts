import { discoveryListing } from '../repository/repository.js';
import { posix } from 'node:path';
import { packageFor, type ReviewConfig } from '../config/review-config.js';
import type { CandidateTest, RelationshipSignal, TestDiscovery, TestDiscoveryRequest } from './test-discovery.js';

/** Pytest/unittest filename conventions and simple absolute from/import statements only. */
export class PythonTestDiscovery implements TestDiscovery {
  constructor(private readonly config?: ReviewConfig) {}
  async discover({ repository, headSha, sourcePaths, signal }: TestDiscoveryRequest) {
    sourcePaths = sourcePaths.filter((path) => path.endsWith('.py'));
    let truncated = sourcePaths.length > 1000;
    sourcePaths = sourcePaths.slice(0, 1000);
    let relationshipCount = 0;
    const listing = await discoveryListing(repository, headSha, signal);
    const all = listing.paths.filter((path) => /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(path));
    const diagnostics: string[] = [];
    const candidates: CandidateTest[] = [];
    const roots = this.config?.packages.flatMap((pkg) => pkg.sourceRoots) ?? [''];
    const modules = new Map<string, string[]>();
    for (const source of sourcePaths.filter((path) => path.endsWith('.py'))) {
      for (const root of roots) {
        if (root && !source.startsWith(`${root}/`)) continue;
        const module = source.slice(root ? root.length + 1 : 0).replace(/\.py$/, '').replace(/\/__init__$/, '').replaceAll('/', '.');
        modules.set(module, [...modules.get(module) ?? [], source]);
      }
    }
    for (const path of all.slice(0, 2000)) {
      signal?.throwIfAborted();
      if (relationshipCount >= 20_000) { truncated = true; diagnostics.push('Python relationship budget exhausted'); break; }
      const relationships: RelationshipSignal[] = [];
      const uncertainty = ['Candidate relationship does not prove that changed behavior is asserted'];
      const stem = posix.basename(path, '.py').replace(/^test_/, '').replace(/_test$/, '');
      for (const source of sourcePaths) {
        if (source.endsWith('.py') && posix.basename(source, '.py') === stem &&
          (!this.config || packageFor(path, this.config) === packageFor(source, this.config))) {
          relationships.push({ type: 'matching-name', sourcePath: source });
        }
      }
      const read = await repository.readSource(headSha, path, signal);
      if (read.status !== 'available') diagnostics.push('Python test source unavailable or truncated');
      else {
        // Do not pretend this bounded lexical adapter is a Python parser.
        if (/\b(?:importlib|__import__)\b|^\s*from\s+\.|^\s*(?:from|import)\b[^\n]*[,()]|[\\]|["']{3}/m.test(read.content)) {
          uncertainty.push('Unsupported Python dynamic/relative import or multiline syntax');
        }
        const imports = [...read.content.matchAll(/^\s*(?:from\s+([A-Za-z_]\w*(?:\.\w+)*)\s+import\s+|import\s+([A-Za-z_]\w*(?:\.\w+)*))/gm)];
        if (imports.length > 100) { truncated = true; diagnostics.push('Python import budget exhausted'); }
        for (const match of imports.slice(0, 100)) {
          const targets = modules.get(match[1] ?? match[2]!) ?? [];
          if (targets.length === 1) relationships.push({ type: 'static-import', sourcePath: targets[0]! });
          else uncertainty.push(targets.length ? 'Ambiguous Python module mapping' : 'Unresolved Python import');
        }
      }
      if (relationships.length > Math.min(100, 20_000 - relationshipCount)) { relationships.length = Math.min(100, 20_000 - relationshipCount); truncated = true; diagnostics.push('Python per-candidate relationship budget exhausted'); }
      relationshipCount += relationships.length;
      if (!relationships.length && uncertainty.length > 1) diagnostics.push('Unresolved Python test relationships');
      if (relationships.length) candidates.push({ path, level: path.split('/').includes('unit') ? 'unit' : path.split('/').includes('integration') ? 'integration' : path.split('/').includes('e2e') ? 'e2e' : 'unknown', relationships, uncertainty });
    }
    truncated ||= listing.status === 'truncated' || all.length > 2000;
    if (truncated) diagnostics.push('Python discovery enumeration is incomplete');
    return { status: truncated ? 'truncated' as const : 'available' as const, candidates, diagnostics: [...new Set(diagnostics)] };
  }
}
