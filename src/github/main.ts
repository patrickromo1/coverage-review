#!/usr/bin/env node
import { runGitHubAction } from './run.js';

try {
  const result = await runGitHubAction(process.argv.slice(2));
  process.stdout.write('help' in result ? result.help : `${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`coverage-review-github: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
