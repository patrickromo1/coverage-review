# coverage-review

A deterministic TypeScript CLI for collecting evidence about changed code, candidate tests, and externally generated coverage. Milestone 2 produces structured evidence only; it does not make coverage findings or verdicts.

## Setup and commands

Requires Node.js 22+, pnpm 11.25.0, and Git on PATH.

```sh
pnpm install
pnpm dev --help
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha>
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --file src/example.ts
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --evidence
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --evidence --lcov /path/to/lcov.info
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --evidence --lcov /path/to/lcov.info --coverage-commit <full-head-sha>
pnpm typecheck
pnpm lint
pnpm test
pnpm test:watch
pnpm build
node dist/cli/main.js --help
```

The default output remains the milestone-1 changed-file JSON. `--file` still returns one unified patch. `--evidence` emits runtime-validated JSON with `schemaVersion: "1"`; `--lcov` and `--coverage-commit` are valid only in evidence mode. Errors go to stderr with exit code 1.

## Architecture and evidence

- `Repository` provides bounded, commit-addressed `readSource` and `listFiles` operations. `LocalRepository` reads Git objects at the resolved base or head commit and never follows snapshot symlinks or reads working-tree content. Source results explicitly distinguish available, missing, binary, truncated, and unsupported data.
- `DiffProvider` remains replaceable for fixtures. `parseUnifiedDiff` converts an individual unified patch into typed hunks, line records, and base/head changed-line ranges. Binary changes are explicit. Added, modified, deleted, renamed, and type-changed files are retained from Git name-status data.
- `TestDiscovery` is injected into evidence collection. `TypeScriptTestDiscovery` searches bounded head-tree listings for TS/JS test conventions and records matching-name, co-location, test-location, and relative static-import signals. A candidate relationship is not proof of behavioral coverage. Test level is `unknown` unless the path explicitly signals unit, integration, or E2E.
- `CoverageProvider` is injected separately. `LcovCoverageProvider` consumes an existing report and parses line (`DA`) and branch (`BRDA`) measurements without running tests. Zero hits remain measured zero; a missing report and a measured report that omits a file are different states.
- `collectEvidence` combines the resolved comparison, structured changes, committed-source availability, related test candidates, and coverage on changed head lines. `CoverageEvidenceSchema` validates the versioned result at runtime. It does not generate `CoverageReview` findings or a verdict.

Git comparisons are direct base-to-head tree comparisons, not merge-base comparisons. Git commands use argument arrays, literal pathspecs, disabled external diff/text conversion, time and output bounds, and sanitized inherited Git configuration. Repository paths are validated as relative slash-separated paths. Because blobs are read directly, working-tree changes cannot affect committed evidence; deleted sources are read from the base commit.

## Limitations

- Test discovery supports JavaScript and TypeScript conventions only. Static relationships recognize relative ESM imports/exports and literal CommonJS `require` calls. It does not execute configuration, resolve aliases, package exports, generated tests, dynamic imports, or framework-specific dependency injection.
- Generic `*.test.*` and `*.spec.*` files have level `unknown`; location/name signals are intentionally conservative. Discovery does not inspect assertions and cannot establish behavioral adequacy.
- LCOV has no standard commit field. Reports are `unverifiable` unless `--coverage-commit` is supplied, and `stale` when supplied metadata differs from the reviewed head. Evidence still exposes measurements with that freshness state rather than silently accepting them as current.
- Only LCOV `SF`, `DA`, and `BRDA` details are used. Summary and function records are ignored. Malformed records, paths outside the repository, duplicate normalized source records, missing files, oversized reports, and unavailable reports are surfaced explicitly.
- Line and branch evidence is filtered to changed head lines. Deleted files and binary changes have no applicable head-line coverage. Pure renames may have no changed lines.
- Git filenames are decoded as UTF-8; arbitrary non-UTF-8 filename bytes are unsupported. Submodule and non-blob sources are reported as unsupported source evidence.
- The tool never executes repository tests or code. Agent SDKs, LLM calls, tracing, GitHub APIs, automated verdicts, and eval scoring remain out of scope.

## Tests

`pnpm test` runs unit tests plus integration tests using disposable local Git repositories. The suite requires no network or real GitHub repository and covers committed snapshots versus working-tree edits, base reads for deletions, structured additions/modifications/deletions/renames/binary changes, static imports, conservative test levels, cosmetic changes, malformed and normalized LCOV, measured zero, missing/stale coverage, and explicit truncation states.
