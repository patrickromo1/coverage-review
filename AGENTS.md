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

Evidence reads Git objects at the reviewed commits, never working-tree source. Test discovery is convention- and static-relative-import-based and must retain uncertainty; it does not prove behavioral coverage. LCOV is external input and has unverifiable freshness unless commit metadata is supplied. Do not resolve module aliases or repository configuration by executing repository code. Missing, unsupported, stale, and truncated evidence must remain explicit in structured output.

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

## Milestone 4 provider and semantic evals

Keep official SDK imports under `src/agent/openai`. `OpenAIReviewAgent` uses the injectable `SdkExecute` boundary, returns a proposal without verdict, and maps the plain strict SDK wire schema (nullable lowerLevelReason) back to domain validation. CLI and both eval modes use `executeReview`. Never weaken policy to improve model scores. Provider mode additionally requires full scoped evidence/source/candidate-test inspection before adequate.

The executor owns `createEvidenceTools`: fixed resolved base/head commits, changed paths and discovered head-test paths only, no arbitrary imports/refs/roots, no new evidence IDs. Arguments/results are validated. Git blobs reject symlinks; tools never execute source or tests. Charge byte reservations before concurrent reads, retain unavailable/truncated states, enforce tool/turn/output limits, and reject new work after cancellation. Default bounds: 8 turns, 30 tools, 32 KiB blob/output, 2 MiB cumulative reservations/output, 200 lines, 4096 output tokens/turn, 256 KiB final proposal. SDK and HTTP retries are both zero. Keep raw SDK exceptions out of output. Distinguish authentication, rate-limit, provider-error, refusal, invalid-proposal, timeout, and budget-exhausted failures; never fall back to scripted execution.

Live review requires `--review --provider openai --model <model-id>` and process environment `OPENAI_API_KEY`. It sends selected committed evidence to OpenAI. Existing modes/help require no credentials. Credentials are never command arguments or logged. Do not run paid live reviews/evals without explicit authorization.

SDK trace export is disabled globally/per runner and processors removed; sensitive SDK logging is disabled. `ReviewTrace` exports nothing unless a callback/CLI `--trace-file` is supplied. Metadata contains stage/duration/status/counts/token usage only. A separate `--trace-sensitive` opt-in adds the bounded provider manifest. No SDK tracing is reenabled. Export failures are non-fatal and wait-bounded; custom non-cooperative exporters and synchronous code cannot be forcibly canceled. Keep source/prompts/tool/model text, secrets, and paths out of default captured spans. Test this with sentinels and mocked network transport.

Semantic fixture snapshots under `evals/fixtures/semantic/v1` are isolated in-memory committed maps; `expected.json` and `scripts.json` must never enter live agent scope. Scoring uses accepted findings and deterministic location/phrase matching with one-to-one maximum matching. Duplicate findings are false positives. FPR uses predefined negative opportunities, not all findings; zero denominators return null. Keep failed/partial cases in aggregates and report unresolved negatives separately from true negatives. Report rejections/status/verdicts separately. Scripted success is not real-model quality. Record fixture/model/prompt/configuration/policy versions and safe available usage.

Run `pnpm eval:offline` in addition to all four completion checks. Live eval is explicit: `pnpm eval:live --model <model-id> --fixtures boundary,cosmetic,transaction --repeats 1 --concurrency 1`. Selection is bounded to 20 IDs, repeats 1–5, concurrency 1–4, and per-run limits. See README for exact scoring denominators, trace opt-ins, cancellation limits, and full CLI examples. No GitHub/Actions publishing or multi-agent review orchestration belongs in this milestone.
