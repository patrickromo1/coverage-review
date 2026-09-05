#!/usr/bin/env node
import { LocalGitDiff } from '../adapters/git/local-git-diff.js';
import { LcovCoverageProvider, UnavailableCoverageProvider } from '../adapters/coverage/lcov-coverage-provider.js';
import { LocalRepository } from '../adapters/repository/local-repository.js';
import { TypeScriptTestDiscovery } from '../core/test-discovery/typescript-test-discovery.js';
import { runCli } from './run.js';

try {
  process.stdout.write(await runCli(
    process.argv.slice(2),
    (root) => new LocalGitDiff(root),
    ({ root, lcov, coverageCommit }) => ({
      diff: new LocalGitDiff(root), repository: new LocalRepository(root), testDiscovery: new TypeScriptTestDiscovery(),
      coverage: lcov === undefined
        ? new UnavailableCoverageProvider()
        : new LcovCoverageProvider(root, lcov, coverageCommit),
    }),
  ));
} catch (error) {
  process.stderr.write(`coverage-review: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
