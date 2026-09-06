# coverage-review

A TypeScript CLI for collecting deterministic evidence about changed code, candidate tests, and externally generated coverage. Milestone 3 adds a shared review executor, validated proposals, and deterministic verdict policy. Review mode is explicitly offline and scripted; no model provider is installed.

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

The default output remains the milestone-1 changed-file JSON. `--file` still returns one unified patch. `--evidence` emits runtime-validated JSON with `schemaVersion: "1"`; `--lcov` and `--coverage-commit` are valid in evidence or offline review mode. Errors go to stderr with exit code 1.

## Architecture and evidence

- `Repository` provides bounded, commit-addressed `readSource` and `listFiles` operations. `LocalRepository` reads Git objects at the resolved base or head commit and never follows snapshot symlinks or reads working-tree content. Source results explicitly distinguish available, missing, binary, truncated, and unsupported data.
- `DiffProvider` remains replaceable for fixtures. `parseUnifiedDiff` converts an individual unified patch into typed hunks, line records, and base/head changed-line ranges. Binary changes are explicit. Added, modified, deleted, renamed, and type-changed files are retained from Git name-status data.
- `TestDiscovery` is injected into evidence collection. `TypeScriptTestDiscovery` searches bounded head-tree listings for TS/JS test conventions and records matching-name, co-location, test-location, and relative static-import signals. A candidate relationship is not proof of behavioral coverage. Test level is `unknown` unless the path explicitly signals unit, integration, or E2E.
- `CoverageProvider` is injected separately. `LcovCoverageProvider` consumes an existing report and parses line (`DA`) and branch (`BRDA`) measurements without running tests. Zero hits remain measured zero; a missing report and a measured report that omits a file are different states.
- `collectEvidence` combines the resolved comparison, structured changes, committed-source availability, related test candidates, and coverage on changed head lines. `CoverageEvidenceSchema` validates the versioned result at runtime. It feeds the shared executor without generating findings or a verdict itself.

Git comparisons are direct base-to-head tree comparisons, not merge-base comparisons. Git commands use argument arrays, literal pathspecs, disabled external diff/text conversion, time and output bounds, and sanitized inherited Git configuration. Repository paths are validated as relative slash-separated paths. Because blobs are read directly, working-tree changes cannot affect committed evidence; deleted sources are read from the base commit.

## Limitations

- Test discovery supports JavaScript and TypeScript conventions only. Static relationships recognize relative ESM imports/exports and literal CommonJS `require` calls. It does not execute configuration, resolve aliases, package exports, generated tests, dynamic imports, or framework-specific dependency injection.
- Generic `*.test.*` and `*.spec.*` files have level `unknown`; location/name signals are intentionally conservative. Discovery does not inspect assertions and cannot establish behavioral adequacy.
- LCOV has no standard commit field. Reports are `unverifiable` unless `--coverage-commit` is supplied, and `stale` when supplied metadata differs from the reviewed head. Evidence still exposes measurements with that freshness state rather than silently accepting them as current.
- Only LCOV `SF`, `DA`, and `BRDA` details are used. Summary and function records are ignored. Malformed records, paths outside the repository, duplicate normalized source records, missing files, oversized reports, and unavailable reports are surfaced explicitly.
- Line and branch evidence is filtered to changed head lines. Deleted files and binary changes have no applicable head-line coverage. Pure renames may have no changed lines.
- Git filenames are decoded as UTF-8; arbitrary non-UTF-8 filename bytes are unsupported. Submodule and non-blob sources are reported as unsupported source evidence.
- The tool never executes repository tests or code. Agent SDKs, LLM calls, tracing, GitHub APIs, and eval scoring remain out of scope.

## Tests

`pnpm test` runs unit tests plus integration tests using disposable local Git repositories. The suite requires no network or real GitHub repository and covers committed snapshots versus working-tree edits, base reads for deletions, structured additions/modifications/deletions/renames/binary changes, static imports, conservative test levels, cosmetic changes, malformed and normalized LCOV, measured zero, missing/stale coverage, and explicit truncation states.

## Shared review execution

`executeReview(baseSha, headSha, dependencies, agent, limits?)` in `src/core/review/execute-review.ts` is the single execution path for offline CLI reviews and `runReviewFixture` in `src/evals/run-fixture.ts`. Future Actions and eval callers can use the same function. The flow is:

1. Collect and runtime-validate milestone-2 `CoverageEvidence` from injected read-only dependencies.
2. Derive deterministic evidence references and retain authoritative evidence privately.
3. Pass a separate evidence copy, references, limits, and an abort signal to an injected `ReviewAgent`.
4. Runtime-validate its untrusted proposal, check scope and findings against evidence, and apply acceptance and verdict policy.
5. Runtime-validate `ReviewResult`; JSON and human formatting are separate functions.

`ReviewAgent` and `ReviewProposalSchema` live under `src/agent`. The contract returns `Promise<unknown>` deliberately: the executor must validate provider output at runtime. Proposals have version, summary, complete/partial status, reviewed file paths, limitations, and proposed findings, **never a verdict**. `ScriptedReviewAgent` accepts data or a callback for deterministic offline testing. There are no provider SDK types, repository execution tools, network calls, telemetry, or publishing operations in this path. Agents must report exhausted budgets or incomplete work as partial or through limitations.

`ReviewResultSchema` under `src/core/review` contains `schemaVersion: "1"`, summary, accepted `findings`, verdict, complete/partial/failed status, comparison and reviewed scope, structured limitations, indexed rejected findings, evidence-reference metadata, and provenance. Scope distinguishes unresolved collection failures from resolved commit comparisons. Provenance includes only executor/policy/evidence versions, agent mode, and configured limits; it contains no source, prompts, absolute report paths, arbitrary exception messages, or provider metadata. Agent-authored summaries and accepted finding text remain untrusted user-visible content and may themselves quote source. The earlier `CoverageReviewSchema` remains a legacy standalone schema and is not used as an executor result or proposal contract.

Evidence references use `ev1:<SHA-256>` IDs over the resolved comparison, canonical changed path, rename/status metadata, evidence kind, and fragment. Available kinds are `diff`, `source`, `tests`, and `coverage`. References are deterministic for identical collected evidence and invalidate when their comparison or fragment changes. Returned metadata provides IDs, paths, and kinds without embedding patches. The executor supplies full evidence and these IDs to the agent.

## Acceptance and verdict policy

All valid low, medium, and high severity findings are accepted and count toward `needs-tests`; severity affects display only. Findings require a canonical changed-file path, explicit positive changed-line location, a base/head side, structured existing-coverage details, a test level, reasoning, and at least one suggested test. The default side is head. For renames use the **new canonical path** with `side: "base"` to identify a changed line at the old path. Added files cannot cite base locations; deleted files cannot cite head locations. Context-only lines, pure renames with no changed lines, binary patches, and unavailable diffs cannot support line findings.

Every cited evidence ID must exist and belong to the finding's changed file; at least one must identify its diff. Cited existing test paths must be discovered candidates for that file. Test levels are unit, integration, or e2e. Integration and E2E recommendations additionally require `lowerLevelReason` explaining why a lower level is insufficient. These checks establish referential validity; they cannot prove the truth of prose, severity, semantic relevance, or the quality of a test-level justification.

- **needs-tests:** one or more findings survive validation, even if other evidence is partial.
- **needs-review:** no accepted findings and analysis is partial or failed.
- **adequate:** no accepted findings, a complete proposal accounting for every changed file exactly once, and no material limitations.

Analysis is **partial** for unavailable/unsupported/truncated coverage reports, stale or unverifiable coverage, report or collection diagnostics, missing/unsupported/binary/truncated source or diff, unsupported source languages, incomplete discovery or discovery diagnostics, additional candidate relationship uncertainty, only E2E/unclassified candidate tests, missing file measurements, uncovered or unknown branches/lines, or changed head lines absent from measurements. Rejected findings, missing/extra/duplicate reviewed paths, and agent-declared limitations also make analysis partial. The standard discovery caveat that candidate relationships do not prove assertions remains a known methodological limitation rather than automatically making every review partial.

This policy is deliberately conservative: LCOV cannot distinguish every unmeasured comment from an unmeasured executable line. A cosmetic-only change without changed-line measurements therefore produces no finding but remains `needs-review`. Even an empty comparison requires complete evidence under the current policy. Coverage percentages and candidate tests alone never establish behavioral assertions; a scripted `adequate` result demonstrates policy plumbing, not independent model analysis.

Analysis is **failed** when evidence collection cannot finish, the agent throws, the deadline expires, or proposal validation fails. Failures have distinct limitation codes (`evidence-unavailable`, `agent-failure`, `timeout`, `invalid-proposal`). Invalid proposal structure, paths, test levels, or limits reject the entire proposal; evidence/location/acceptance failures reject individual findings with indexed reasons and retain other valid findings. Raw invalid output and exception messages are not copied into results. Configuration and proposal-file I/O/JSON syntax errors are CLI errors; structurally invalid parsed proposals return a failed review result. CLI exit code remains 0 for structured review results of any verdict, and 1 for invocation errors; downstream consumers should inspect the verdict and status.

## Offline examples and limits

Run a deliberately incomplete plumbing check, without API access:

```sh
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --offline-review evals/fixtures/review/empty-proposal.json
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --offline-review evals/fixtures/review/empty-proposal.json --json
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --offline-review /path/to/proposal.json --json --lcov /path/to/lcov.info --coverage-commit <full-head-sha> --max-findings 25 --max-text-length 2000 --timeout-ms 10000
```

Human output starts with `OFFLINE SCRIPTED REVIEW`; JSON records `provenance.agentMode: "scripted"`. `--offline-review`, `--file`, and `--evidence` are mutually exclusive; `--json` and review limits require offline mode. To author a proposal, use an initial offline JSON result's `scope.changedFiles` and `evidenceReferences`, inspect the corresponding `--evidence` output, and supply your explicit reviewed scope, findings, and limitations. IDs are commit/evidence-specific, so regenerate after changing evidence inputs. A finding extends the existing structured finding fields with a required `line`, `evidenceRefs` array, and optional `lowerLevelReason`. Programmatic scripted callbacks receive the evidence and IDs directly.

Defaults are 50 findings, 4,000 characters per text field, and a 30,000 ms total collection/agent deadline. Configuration allows 1–1,000 findings, 1–100,000 characters, and 1–300,000 ms. Over-limit proposals fail validation without silent truncation. Arrays also have fixed bounds: 10,000 reviewed paths, 50 agent limitations, 100 cited tests per finding, 20 references and 20 suggested tests per finding. CLI proposal files must be regular files no larger than 1 MiB. Existing Git, source-read, discovery, and LCOV input bounds still apply.

The deadline covers collection and agent invocation together. Timeout returns a failed result and aborts the agent signal. In-process cancellation is cooperative: a non-cooperative promise or collector may keep running after the executor returns, and synchronous JavaScript cannot be preempted (elapsed deadlines are checked when it returns). Provider adapters must enforce their own transport/resource bounds. The application never runs repository tests, writes repository source, modifies Git, or publishes review results.

`evals/fixtures/review/cases.json` includes missing-test, cosmetic-only, adequately-tested, and E2E-only-validation cases. Integration tests build disposable local repositories, collect real Git/LCOV evidence, and compare fixture-runner and CLI results, including the CLI process entrypoint. Fixture tests are read as text and never executed. These fixtures exercise deterministic orchestration and policy; they do not measure real-model precision/recall or establish real behavioral coverage.
