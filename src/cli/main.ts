#!/usr/bin/env node
import { LocalGitDiff } from '../adapters/git/local-git-diff.js';
import { LcovCoverageProvider, UnavailableCoverageProvider } from '../adapters/coverage/lcov-coverage-provider.js';
import { LocalRepository } from '../adapters/repository/local-repository.js';
import { SupportedTestDiscovery } from '../core/test-discovery/supported-test-discovery.js';
import { MultipleCoverageProvider } from '../adapters/coverage/multiple-coverage-provider.js';
import { captureLocalReview } from '../adapters/repository/local-snapshot.js';
import { runCli } from './run.js';

try {
  process.stdout.write(await runCli(
    process.argv.slice(2),
    (root) => new LocalGitDiff(root),
    ({ root, lcov, coverageCommit, config }) => ({
      captureLocal: (mode, signal) => captureLocalReview(root, mode, signal),
      diff: new LocalGitDiff(root), repository: new LocalRepository(root), testDiscovery: new SupportedTestDiscovery(config),
      coverage: config ? new MultipleCoverageProvider(root, config.reports) : lcov === undefined
        ? new UnavailableCoverageProvider()
        : new LcovCoverageProvider(root, lcov, coverageCommit),
    }),
  ));
} catch (error) {
  process.stderr.write(`coverage-review: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
