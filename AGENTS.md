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

Use `pnpm dev --help` for CLI usage, `pnpm build` to compile, `pnpm typecheck` for strict checks, `pnpm lint` for ESLint, and `pnpm test` for Vitest unit and integration tests. `pnpm test:watch` starts watch mode. Eval tooling is not implemented yet.

Milestone 2 evidence can be inspected with:

```sh
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --evidence
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --evidence --lcov /path/to/lcov.info --coverage-commit <full-head-sha>
```

Evidence reads Git objects at the reviewed commits, never working-tree source. Test discovery is convention- and static-relative-import-based and must retain uncertainty; it does not prove behavioral coverage. LCOV is external input and has unverifiable freshness unless commit metadata is supplied. Do not resolve module aliases or repository configuration by executing repository code. Missing, unsupported, stale, and truncated evidence must remain explicit in structured output.

## Completion Checks

Before completing a task, run the project’s type check, lint, unit/integration tests, and production build using `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`. If a check is unavailable, state that explicitly rather than claiming it passed.

Fix failures caused by the change. Explain meaningful architectural decisions and validation limitations.
