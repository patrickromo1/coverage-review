#!/usr/bin/env node
import { LocalGitDiff } from '../adapters/git/local-git-diff.js';
import { runCli } from './run.js';

try {
  process.stdout.write(await runCli(process.argv.slice(2), (root) => new LocalGitDiff(root)));
} catch (error) {
  process.stderr.write(`coverage-review: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
