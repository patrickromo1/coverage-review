# coverage-review

A TypeScript CLI foundation for analyzing missing automated test coverage. This milestone implements deterministic Git inspection and review data schemas only. It does not generate coverage findings yet.

## Setup and commands

Requires Node.js 22+, pnpm 11.25.0, and Git on PATH.

```sh
pnpm install
pnpm dev --help
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha>
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --file src/example.ts
pnpm typecheck
pnpm lint
pnpm test
pnpm test:watch
pnpm build
node dist/cli/main.js --help
```

Replace SHA placeholders with full commit IDs. The default output is JSON containing resolved SHAs and changed files; `--file` outputs a unified patch. Errors go to stderr with exit code 1. Help and successful inspection exit with code 0. No coverage verdict is inferred from the diff.

## Boundaries

- `Repository` (`src/core/repository/repository.ts`) exposes bounded source reads. `LocalRepository` reads the current filesystem checkout; it is **not** a commit snapshot. It rejects traversal, escaping symlinks, non-files, and reads exceeding 1 MiB by default. Use a stable checkout; concurrent hostile filesystem mutation is outside this adapter's guarantees.
- `DiffProvider` (`src/core/diff/diff-provider.ts`) compares two commits and retrieves an individual changed file's patch. Fixtures can implement this interface without Git. `LocalGitDiff` invokes Git with argument arrays, literal pathspecs, disabled external diff/text conversion, a 30-second timeout, and a 16 MiB output limit. Limit failures throw rather than silently truncate.
- `CoverageFindingSchema` and `CoverageReviewSchema` (`src/core/review/schema.ts`) use Zod runtime validation and inferred TypeScript types. Reviews carry schema version `1`, summary, findings, and a verdict. Findings distinguish unknown coverage from absent coverage, carry base/head line coordinates, and recommend structured test scenarios. These are shape contracts; semantic verdict policy is deferred.

Comparisons are direct base-to-head tree comparisons, not merge-base comparisons. Working-tree edits do not affect Git output. Added, modified, deleted, renamed, and type-changed paths are supported. A deleted file uses its base path; a rename uses its destination plus `previousPath`. Rename detection uses Git's 50% heuristic. Binary changes return Git's binary notice, not decoded content. Submodule changes return Git's short patch representation. Git filenames are decoded as UTF-8; arbitrary non-UTF-8 filename bytes are not supported.

## Tests and scope

Unit tests cover parsing, schema validation, filesystem containment, and the CLI with an injected fake provider. Integration tests create disposable local Git repositories; no GitHub access is needed. `pnpm test` runs both suites.

Agent SDKs, tracing, GitHub APIs, coverage parsing, test discovery, and eval scoring are intentionally deferred. No eval command is available yet.
