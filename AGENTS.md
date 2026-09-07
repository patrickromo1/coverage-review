# Coverage Review Project Instructions

## General

`coverage-review` is a TypeScript application for analyzing Git diffs and identifying missing or inadequate automated test coverage, locally and in GitHub Actions.

Prefer simple, explicit architecture over unnecessary abstractions. Build incrementally and avoid large unrelated refactors during focused tasks.

## Architecture

Keep deterministic analysis separate from LLM reasoning. Keep these deterministic where practical:

- Git diff parsing and changed-file discovery
- Coverage-file parsing and test discovery
- Configuration and GitHub API interaction
- Result validation, verdict policy, and formatting

Keep domain logic under `src/core` and agent SDK code under `src/agent`. Do not let provider types leak into the domain layer. Use typed interfaces between the agent and repository-analysis functionality.

Share one core execution path between local runs and GitHub Actions. Keep tracing based on OpenTelemetry concepts where practical. Disable source and prompt export in traces by default; require explicit configuration to enable it.

## Agent Behavior

The coverage review agent is read-only. Do not give it tools that modify source files, execute repository tests, commit changes, push branches, or post GitHub comments directly. Consume coverage generated externally by CI or a user-controlled step.

Bound repository reads and search results. Enforce repository path containment, including symlink resolution, to prevent access outside the review scope.

Return structured review data and handle GitHub output separately from agent execution. These restrictions apply to the application’s review agent, not contributors implementing and testing the application.

## Test Pyramid

Recommend the lowest appropriate test level:

1. Unit
2. Integration
3. E2E

Do not recommend E2E when the same behavior can reasonably be tested at a lower level.

## Evals

Design outputs for automated evaluation. Prefer structured schemas over free-form Markdown. Keep fixtures under `evals/fixtures`, isolated from production GitHub integrations and runnable without real GitHub repositories.

Track finding precision, recall, false-positive rate, false-negative rate, and test-level classification accuracy. Include missing-test, cosmetic-change, and E2E-only-validation cases.

## Development

Use Node.js, TypeScript, pnpm, Vitest, and Zod. Keep TypeScript strict. Add tests for new deterministic behavior; keep tests under `tests` and name them `*.test.ts`.

Use `pnpm dev --help` for CLI usage, `pnpm build` to compile, `pnpm typecheck` for strict checks, `pnpm lint` for ESLint, and `pnpm test` for Vitest unit and integration tests. `pnpm test:watch` starts watch mode. The offline `runReviewFixture` API and deterministic semantic scoring are available; run `pnpm eval:offline` for the versioned scripted suite.

Milestone 2 evidence can be inspected with:

```sh
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --evidence
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --evidence --lcov /path/to/lcov.info --coverage-commit <full-head-sha>
```

Commit evidence reads Git objects at the reviewed commits; explicit local snapshot modes capture tracked content once through the executor. Test discovery is convention- and static-relative-import-based and must retain uncertainty; it does not prove behavioral coverage. LCOV is external input and has unverifiable freshness unless commit metadata is supplied. Do not resolve module aliases or repository configuration by executing repository code. Missing, unsupported, stale, and truncated evidence must remain explicit in structured output.

## Completion Checks

Before completing a task, run the project’s type check, lint, unit/integration tests, and production build using `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`. If a check is unavailable, state that explicitly rather than claiming it passed.

Fix failures caused by the change. Explain meaningful architectural decisions and validation limitations.

## Milestone 3 review execution

Use `executeReview` in `src/core/review/execute-review.ts` for every review entrypoint. It collects milestone-2 evidence, generates commit-bound evidence references, calls an injected `ReviewAgent`, validates its untrusted proposal and findings, applies deterministic policy, and validates `ReviewResult`. Keep formatting in `format-review.ts`. CLI and `src/evals/run-fixture.ts` share this executor.

Keep provider-independent `ReviewAgent` and proposal contracts under `src/agent`; agents return proposals without verdicts. `ScriptedReviewAgent` is explicitly offline. Keep acceptance and verdict logic under `src/core/review`. The legacy `CoverageReviewSchema` is not the executor contract. Result provenance must exclude source, prompts, raw exceptions, and provider metadata.

Accept all valid low/medium/high severity findings. Require changed-file paths, changed lines on valid base/head sides, file-local evidence references including a diff reference, and discovered candidate paths for cited tests. Rename base locations use the canonical new path. Require a lower-level justification for integration/E2E recommendations. Reference checks cannot prove semantic claims or justifications.

Derive `needs-tests` for any accepted findings, `needs-review` for no findings with partial/failed analysis, and `adequate` only for complete scope and evidence with no findings. Missing, unsupported, binary, truncated, stale/unverifiable evidence, discovery diagnostics/additional uncertainty, only E2E/unclassified candidates, uncovered/unknown/missing changed-line measurements, rejected findings, incomplete scope, and agent limitations prevent adequate. Cosmetic changes without measurements remain needs-review under this conservative policy. Do not silently convert a budget limit, timeout, rejected proposal, or missing evidence to adequate.

Collection/agent exceptions, timeout, and invalid output produce distinct structured failed results. Default limits are 50 findings, 4,000 characters per text field, and a 30-second total collection/agent deadline. Bounds are configurable and validated; do not silently truncate proposals. Cancellation is cooperative and must be backed by adapter resource limits. Offline proposal input has a 1 MiB cap. Provider SDK/network code belongs only in `src/agent/openai`; deterministic review analysis must not publish, mutate Git, or execute repository tests. Application tracing is metadata-only by default.

```sh
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --offline-review evals/fixtures/review/empty-proposal.json --json
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --offline-review /path/to/proposal.json --lcov /path/to/lcov.info --coverage-commit <full-head-sha> --max-findings 25 --max-text-length 2000 --timeout-ms 10000
```

Offline output must identify itself as scripted. Existing changed-file, `--file`, and `--evidence` modes remain available. Add deterministic unit tests and local integration fixtures for policy changes, and audit every new failure/uncertainty path for accidental adequate verdicts. Keep fixture data under `evals/fixtures`; never execute fixture repository code during analysis. See README for exact schema boundaries, limits, failure behavior, and remaining methodological limitations.

## Milestone 5 GitHub execution

Every Actions review must use `executeReview`; GitHub event resolution and Check/artifact formatting are separate adapters under `src/github`. Never expose the GitHub client or token to a `ReviewAgent`. Accept repository identity, PR number, and full base/head commits only from a bounded event payload validated against `GITHUB_REPOSITORY`; no GitHub CLI flag may select them. Use the PR merge base when resolved and retain the trusted head SHA.

Only `pull_request` is analyzable. `pull_request_target`, `merge_group`, manual, and unsupported contexts must remain explicit non-success results. Fork PRs may run an explicitly configured offline proposal but never live provider review; do not substitute modes, expose secrets, or grant write tokens. Review analysis never runs tests or repository code. Actions LCOV/proposal inputs must be regular, non-symlink, bounded files contained in `GITHUB_WORKSPACE`.

Checks are derived only from a validated result and bind to the reviewed head. Only complete `adequate` maps to success; `needs-tests` maps to failure, and all partial/failed/needs-review paths map to neutral. Annotate accepted findings only, in deterministic batches of at most 50, with a bounded total. Publishing failures remain separate from `ReviewResult`. Write the versioned CI artifact atomically inside the workspace and use only fixed single-line GitHub output keys. Keep credentials, source, patches, prompts, raw provider/API payloads, filesystem paths, and model prose out of logs, command channels, errors, traces, and Check summaries.

The REST adapter uses fixed GitHub endpoints, runtime-validates responses, bounds requests/pages/bytes/retries, retries only safe transient failures, sanitizes errors, and propagates abort signals. Normal tests and offline examples must remain credential-free and network-free. Never publish a real Check or run a paid provider request during development without explicit authorization.

## Milestone 4 provider and semantic evals

Keep official SDK imports under `src/agent/openai`. `OpenAIReviewAgent` uses the injectable `SdkExecute` boundary, returns a proposal without verdict, and maps the plain strict SDK wire schema (nullable lowerLevelReason) back to domain validation. CLI and both eval modes use `executeReview`. Never weaken policy to improve model scores. Provider mode additionally requires full scoped evidence/source/candidate-test inspection before adequate.

The executor owns `createEvidenceTools`: fixed resolved base/head commits, changed paths and discovered head-test paths only, no arbitrary imports/refs/roots, no new evidence IDs. Arguments/results are validated. Git blobs reject symlinks; tools never execute source or tests. Charge byte reservations before concurrent reads, retain unavailable/truncated states, enforce tool/turn/output limits, and reject new work after cancellation. Default bounds: 8 turns, 30 tools, 32 KiB blob/output, 2 MiB cumulative reservations/output, 200 lines, 4096 output tokens/turn, 256 KiB final proposal. SDK and HTTP retries are both zero. Keep raw SDK exceptions out of output. Distinguish authentication, rate-limit, provider-error, refusal, invalid-proposal, timeout, and budget-exhausted failures; never fall back to scripted execution.

Live review requires `--review --provider openai --model <model-id>` and process environment `OPENAI_API_KEY`. It sends selected committed evidence to OpenAI. Existing modes/help require no credentials. Credentials are never command arguments or logged. Do not run paid live reviews/evals without explicit authorization.

SDK trace export is disabled globally/per runner and processors removed; sensitive SDK logging is disabled. `ReviewTrace` exports nothing unless a callback/CLI `--trace-file` is supplied. Metadata contains stage/duration/status/counts/token usage only. A separate `--trace-sensitive` opt-in adds the bounded provider manifest. No SDK tracing is reenabled. Export failures are non-fatal and wait-bounded; custom non-cooperative exporters and synchronous code cannot be forcibly canceled. Keep source/prompts/tool/model text, secrets, and paths out of default captured spans. Test this with sentinels and mocked network transport.

Semantic fixture snapshots under `evals/fixtures/semantic/v1` are isolated in-memory committed maps; `expected.json` and `scripts.json` must never enter live agent scope. Scoring uses accepted findings and deterministic location/phrase matching with one-to-one maximum matching. Duplicate findings are false positives. FPR uses predefined negative opportunities, not all findings; zero denominators return null. Keep failed/partial cases in aggregates and report unresolved negatives separately from true negatives. Report rejections/status/verdicts separately. Scripted success is not real-model quality. Record fixture/model/prompt/configuration/policy versions and safe available usage.

Run `pnpm eval:offline` in addition to all four completion checks. Live eval is explicit: `pnpm eval:live --model <model-id> --fixtures boundary,cosmetic,transaction --repeats 1 --concurrency 1`. Selection is bounded to 20 IDs, repeats 1–5, concurrency 1–4, and per-run limits. See README for exact scoring denominators, trace opt-ins, cancellation limits, and full CLI examples. GitHub/Actions publishing stays in the separate milestone-5 adapters. Do not add multi-agent review orchestration.

## Milestone 6 hardening

`executeReview` remains the only review executor. Explicit `reviewMode: staged|unstaged` invokes an injected capture adapter inside its deadline. `captureLocalReview` never writes repository content, the index, or Git objects: it uses immutable maps and private temporary files for `git diff --no-index`. Bound capture to 2,000 entries/snapshot, 500 changed paths, 32 KiB/file, 32 MiB including verification/retry reads, 10,000 requests, two attempts, and 30 seconds. Reject conflicts and unsafe/inconsistent captures as failed analysis. Untracked files stay excluded. Exact renames retain canonical new finding paths and base-side previous paths; edited/ambiguous renames stay add/delete. Do not claim an atomic transaction against adversarial filesystem mutation.

Local result/evidence schema is v2 with `local:<sha256>` identities, `ev2:` references, and `snapshotMode`; staged base is HEAD's real SHA. Commit schema remains v1/ev1 and accepts old fixtures/artifacts. Optional evidence-scope/report fields require upgrading old strict consumers. Validate identity/version consistency. CI envelope v1 rejects local results. Coverage with commit metadata is always unverifiable for local snapshots, regardless of provider claims. Keep proposals version 1, without verdicts.

Use `ReviewRepository` for per-review caching, byte reservations, concurrency, and internal pagination. Defaults: 20,000 files, 4,000 reads, 32 KiB/read, 16 MiB reserved reads, 4 MiB cache, four active reads; cache only within the same repository/review/snapshots/read configuration. Pages have at most 500 entries, 40/traversal, 400/session. Cursors bind query/snapshot/listing and must be rejected on mismatch. Pass cancellation into all adapters and check it before scheduling. Collection caps changed-file evidence at 500 files and 16 MiB patches, retaining omitted paths and `scope.evidenceScope`. Never let subsets or exhausted budgets appear complete/adequate.

Explicit `--config` is bounded data-only JSON (64 KiB, depth 16, unique keys, 50 packages, 20 source roots/package, 20 reports), validated by `ReviewConfigSchema`; never evaluate workspace configuration. Package/source roots cannot overlap/escape. Config report paths are repository-relative regular files with symlink checks. Config cannot change credentials, endpoints, publishing, trusted GitHub identity, or limits. Reject config plus legacy LCOV flags instead of merging implicitly. Preserve cross-package static evidence while restricting basename hints to their package.

Coverage adapters stay behind `CoverageProvider`. Multiple reports have 16 MiB individual/32 MiB aggregate byte budgets and 200,000 aggregate measurement records. Failed reads consume reservations. Preserve per-report format/root/commit/digest/freshness/status/diagnostics. Identical measurements are idempotent; conflicting overlap removes measurements and adds uncertainty. One fresh report never hides stale/failed evidence. Coverage.py JSON format 3 is supported for the Python fixture: executed/missing lines and arcs are 1/0 booleans, not frequencies; absent/excluded lines remain absent. Reject unknown format versions, duplicate keys/measurements, malformed/unsafe inputs, and excessive nesting/records. Branch-disabled JSON is uncertain. LCOV unknown branches retain null hits and null covered state. Never generate coverage during review.

Bound each language pass to 1,000 source paths, 100 imports/relationships per candidate, and 20,000 total relationships; preserve explicit truncation and file-local relationship filtering. Use `SupportedTestDiscovery` for JS/TS plus focused Python `test_*.py`/`*_test.py` conventions and simple absolute imports. Python module roots are explicit data; aliases, relative/dynamic/multiline syntax, unresolved/ambiguous imports, and unsupported languages remain uncertain. Test names, imports, and measurements never prove assertions or justify escalating above the lowest appropriate test level. No plugin runtime or additional model providers.

Keep operational telemetry allowlisted and path/prose/source/credential-free. Trace export is off by default. Capture, discovery, coverage, collection, validation, and publishing metadata must not expose inputs. Publishing outcomes remain separate. No additional privileged publishing workflow was justified; do not treat the result-level artifact helper as complete trusted API provenance validation.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm eval:offline`, `pnpm action:smoke`, `pnpm benchmark:hardening`, and help for changed entrypoints. The benchmark fixture and measured operation counts are under `evals/fixtures/hardening`; assert counts, not wall-clock thresholds. Baseline 100-file comparison: 403→103 Git requests, 200→100 source reads. Offline semantic fixtures now include Python and local-freshness cases; report scripted precision/recall/FPR/FNR/level accuracy, failures, and unresolved cases separately from real-model quality. See README for complete budgets, mappings, schema migration, capture limitations, and deferred expansion.
