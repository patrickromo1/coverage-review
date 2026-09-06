# coverage-review

A TypeScript CLI for collecting deterministic evidence about changed code, candidate tests, and externally generated coverage. Milestones 1–6 provide an explicitly selected OpenAI reviewer, deterministic semantic evals, GitHub Actions/Checks, bounded monorepo evidence, and immutable local snapshots through one shared executor. Offline modes remain credential-free.

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

The default output remains the milestone-1 changed-file JSON. `--file` still returns one unified patch. `--evidence` emits runtime-validated JSON with `schemaVersion: "1"`; `--lcov` and `--coverage-commit` are valid in evidence, offline, or live review mode. Errors go to stderr with exit code 1.

## Architecture and evidence

- `Repository` provides bounded, commit-addressed `readSource` and `listFiles` operations. `LocalRepository` reads Git objects at the resolved base or head commit and never follows snapshot symlinks or reads working-tree content. Source results explicitly distinguish available, missing, binary, truncated, and unsupported data.
- `DiffProvider` remains replaceable for fixtures. `parseUnifiedDiff` converts an individual unified patch into typed hunks, line records, and base/head changed-line ranges. Binary changes are explicit. Added, modified, deleted, renamed, and type-changed files are retained from Git name-status data.
- `TestDiscovery` is injected into evidence collection. `TypeScriptTestDiscovery` searches bounded head-tree listings for TS/JS test conventions and records matching-name, co-location, test-location, and relative static-import signals. A candidate relationship is not proof of behavioral coverage. Test level is `unknown` unless the path explicitly signals unit, integration, or E2E.
- `CoverageProvider` is injected separately. `LcovCoverageProvider` consumes an existing report and parses line (`DA`) and branch (`BRDA`) measurements without running tests. Zero hits remain measured zero; a missing report and a measured report that omits a file are different states.
- `collectEvidence` combines the resolved comparison, structured changes, committed-source availability, related test candidates, and coverage on changed head lines. `CoverageEvidenceSchema` validates the versioned result at runtime. It feeds the shared executor without generating findings or a verdict itself.

Git comparisons are direct base-to-head tree comparisons, not merge-base comparisons. Git commands use argument arrays, literal pathspecs, disabled external diff/text conversion, time and output bounds, and sanitized inherited Git configuration. Repository paths are validated as relative slash-separated paths. Because blobs are read directly, working-tree changes cannot affect committed evidence; deleted sources are read from the base commit.

## Limitations

- Test discovery supports JavaScript/TypeScript and focused Python conventions (detailed below). Static relationships recognize relative ESM imports/exports and literal CommonJS `require` calls. It does not execute configuration, resolve aliases, package exports, generated tests, dynamic imports, or framework-specific dependency injection.
- Generic `*.test.*` and `*.spec.*` files have level `unknown`; location/name signals are intentionally conservative. Discovery does not inspect assertions and cannot establish behavioral adequacy.
- LCOV has no standard commit field. Reports are `unverifiable` unless `--coverage-commit` is supplied, and `stale` when supplied metadata differs from the reviewed head. Evidence still exposes measurements with that freshness state rather than silently accepting them as current.
- Only LCOV `SF`, `DA`, and `BRDA` details are used. Summary and function records are ignored. Malformed records, paths outside the repository, duplicate normalized source records, missing files, oversized reports, and unavailable reports are surfaced explicitly.
- Line and branch evidence is filtered to changed head lines. Deleted files and binary changes have no applicable head-line coverage. Pure renames may have no changed lines.
- Git filenames are decoded as UTF-8; arbitrary non-UTF-8 filename bytes are unsupported. Submodule and non-blob sources are reported as unsupported source evidence.
- Review analysis never executes repository tests or code. GitHub Actions and opt-in Checks publishing run through separate adapters.

## Tests

`pnpm test` runs unit tests plus integration tests using disposable local Git repositories. The suite requires no network or real GitHub repository and covers committed snapshots versus working-tree edits, base reads for deletions, structured additions/modifications/deletions/renames/binary changes, static imports, conservative test levels, cosmetic changes, malformed and normalized LCOV, measured zero, missing/stale coverage, and explicit truncation states.

## Shared review execution

`executeReview(baseSha, headSha, dependencies, agent, limits?, trace?)` in `src/core/review/execute-review.ts` is the single execution path for live/offline CLI reviews, semantic evals, and `runReviewFixture` in `src/evals/run-fixture.ts`. Future Actions and eval callers can use the same function. The flow is:

1. Collect and runtime-validate milestone-2 `CoverageEvidence` from injected read-only dependencies.
2. Derive deterministic evidence references and retain authoritative evidence privately.
3. Pass a separate evidence copy, references, limits, and an abort signal to an injected `ReviewAgent`.
4. Runtime-validate its untrusted proposal, check scope and findings against evidence, and apply acceptance and verdict policy.
5. Runtime-validate `ReviewResult`; JSON and human formatting are separate functions.

`ReviewAgent` and `ReviewProposalSchema` live under `src/agent`. The contract returns `Promise<unknown>` deliberately: the executor must validate provider output at runtime. Proposals have version, summary, complete/partial status, reviewed file paths, limitations, and proposed findings, **never a verdict**. `ScriptedReviewAgent` accepts data or a callback for deterministic offline testing. SDK types remain inside the OpenAI adapter. The executor owns bounded read-only tools and metadata tracing; only the explicitly selected provider adapter makes model network calls. Agents must report exhausted budgets or incomplete work as partial or through limitations.

`ReviewResultSchema` under `src/core/review` contains `schemaVersion: "1"`, summary, accepted `findings`, verdict, complete/partial/failed status, comparison and reviewed scope, structured limitations, indexed rejected findings, evidence-reference metadata, and provenance. Scope distinguishes unresolved collection failures from resolved commit comparisons. Provenance includes only executor/policy/evidence versions, agent mode, and configured limits; it contains no source, prompts, absolute report paths, arbitrary exception messages, or provider metadata. Agent-authored summaries and accepted finding text remain untrusted user-visible content and may themselves quote source. The earlier `CoverageReviewSchema` remains a legacy standalone schema and is not used as an executor result or proposal contract.

Evidence references use `ev1:<SHA-256>` IDs over the resolved comparison, canonical changed path, rename/status metadata, evidence kind, and fragment. Available kinds are `diff`, `source`, `tests`, and `coverage`. References are deterministic for identical collected evidence and invalidate when their comparison or fragment changes. Returned metadata provides IDs, paths, and kinds without embedding patches. The executor supplies full evidence and these IDs to the injected adapter. The OpenAI adapter sends a bounded path manifest initially and exposes evidence through scoped tools.

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

Human output starts with `OFFLINE SCRIPTED REVIEW`; JSON records `provenance.agentMode: "scripted"`. `--offline-review`, `--review`, `--file`, and `--evidence` are mutually exclusive; `--json` and review limits require a review mode. To author a proposal, use an initial offline JSON result's `scope.changedFiles` and `evidenceReferences`, inspect the corresponding `--evidence` output, and supply your explicit reviewed scope, findings, and limitations. IDs are commit/evidence-specific, so regenerate after changing evidence inputs. A finding extends the existing structured finding fields with a required `line`, `evidenceRefs` array, and optional `lowerLevelReason`. Programmatic scripted callbacks receive the evidence and IDs directly.

Defaults are 50 findings, 4,000 characters per text field, and a 30,000 ms total collection/agent deadline. Configuration allows 1–1,000 findings, 1–100,000 characters, and 1–300,000 ms. Over-limit proposals fail validation without silent truncation. Arrays also have fixed bounds: 10,000 reviewed paths, 50 agent limitations, 100 cited tests per finding, 20 references and 20 suggested tests per finding. CLI proposal files must be regular files no larger than 1 MiB. Existing Git, source-read, discovery, and LCOV input bounds still apply.

The deadline covers collection and agent invocation together. Timeout returns a failed result and aborts the agent signal. In-process cancellation is cooperative: a non-cooperative promise or collector may keep running after the executor returns, and synchronous JavaScript cannot be preempted (elapsed deadlines are checked when it returns). Provider adapters must enforce their own transport/resource bounds. Review analysis never runs repository tests, writes repository source, modifies Git, or publishes results; the separate Actions publisher may publish an explicitly requested Check.

`evals/fixtures/review/cases.json` includes missing-test, cosmetic-only, adequately-tested, and E2E-only-validation cases. Integration tests build disposable local repositories, collect real Git/LCOV evidence, and compare fixture-runner and CLI results, including the CLI process entrypoint. Fixture tests are read as text and never executed. These fixtures exercise deterministic orchestration and policy; they do not measure real-model precision/recall or establish real behavioral coverage.

## OpenAI review

`src/agent/openai` contains all SDK imports. `OpenAIReviewAgent` accepts a narrow injectable `SdkExecute` function; tests can replace it without credentials. The production implementation uses official `@openai/agents` 0.17.0 with OpenAI 7.10.0, Responses, one agent, one read-only tool, no handoffs, no hosted tools, and no automatic retries. `OpenAIProposalSchema` requires every wire key, uses nullable `lowerLevelReason`, and has no verdict. Mapping removes null before applying the original domain schema; the executor still validates the proposal and independently accepts/rejects every finding.

The implementation was checked against the installed SDK declarations and implementations (`run`, `model`, `tool`, `result`, `config`, `OpenAIProvider`) and official [agent definitions](https://developers.openai.com/api/docs/guides/agents/define-agents), [running agents](https://developers.openai.com/api/docs/guides/agents/running-agents), and [tracing documentation](https://developers.openai.com/api/docs/guides/agents/integrations-observability). Tests run the installed SDK against a mocked HTTP transport to check actual schema conversion, request options, refusals, errors, and turn limits.

Set `OPENAI_API_KEY` in the launching process environment using your secret manager or shell. No `.env` files are automatically loaded, and keys must never be passed as CLI arguments. There is no default model: `--model` must explicitly name a model accessible to your project that supports Responses function tools and strict JSON structured output. Model availability and semantic quality have not been live-tested. The API endpoint is fixed to `https://api.openai.com/v1`; arbitrary endpoints, other providers, websocket transport, and ambient `OPENAI_BASE_URL` are unsupported.

```sh
# Paid/networked: run only when intended. Supply a supported model ID and full commit SHAs.
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --review --provider openai --model <model-id> --json
pnpm dev --repo /path/to/repo --base <full-base-sha> --head <full-head-sha> --review --provider openai --model <model-id> --lcov /path/to/lcov.info --coverage-commit <full-head-sha> --timeout-ms 60000 --max-turns 8 --max-tool-calls 30
```

Live mode sends selected committed repository evidence to OpenAI. Human output identifies provider mode; JSON records `agentMode: "provider"`. Missing credentials, authentication/permission errors, rate limits, provider errors, refusals, invalid output, timeouts, and budget exhaustion become safe structured failures; none fall back to scripted analysis. Provider payloads and keys are never included in failure messages. Result summaries/findings remain untrusted model-authored text, separate from redacted operational errors and traces.

### Tool scope and limits

`createEvidenceTools` is owned by the executor and receives its authoritative evidence, references, resolved commits, repository, and abort signal. `inspect_evidence` accepts a canonical changed path, kind (`evidence`, `diff`, `source`, `test`), side, nullable candidate test path, start line, and line count. It can read only changed-file base/head sources and discovered candidate tests at head. Rename base reads resolve the previous path internally. It cannot select repositories, roots, refs, arbitrary imports, or annotation files. It cannot execute shell commands, tests, repository configuration, edits, Git writes, network requests, or publishing.

Arguments and results are validated, paths are checked before IO, and Git reads reject symlinks/non-blobs. Source lines are numbered. Missing, binary, unsupported, unavailable, and truncated results remain explicit. Tools reuse existing file-local source/test/diff/coverage reference IDs; they do not mint new references or trust model-supplied IDs. These references bind the comparison and collected fragment, not a claim that the full test body proves a behavior.

| Bound | Default | Configurable range |
| --- | ---: | --- |
| SDK turns | 8 | 1–30 (`--max-turns`) |
| Tool invocations | 30 | 1–200 (`--max-tool-calls`) |
| Cumulative tool read/output budget | 2 MiB | 1 KiB–16 MiB (`--max-read-bytes`) |
| Source blob / serialized tool result | 32 KiB | 1–256 KiB (`--max-tool-bytes`) |
| Source lines per call | 200 | 1–1,000 (adapter API `maxLines`) |
| Model output tokens per turn | 4,096 | 256–32,768 (`--max-output-tokens`) |
| Final proposal bytes | 256 KiB | 1 KiB–1 MiB (adapter API `maxOutputBytes`) |
| Retries | 0 | Fixed at both SDK/client layers |

The initial manifest has the same byte cap as a tool result. Each source/test call reserves the blob byte cap **before** asynchronous IO and additionally charges serialized output; rereads are charged again. Small budgets can therefore stop a run even when actual blobs are smaller than the reservation. Oversized blobs are unavailable as complete evidence; requesting a smaller line range cannot bypass the blob cap. Oversized evidence/diff results return a truncation state. Earlier collector bounds remain independent of these provider inspection limits.

The executor aborts on its original collection/agent deadline and closes tools on every exit. The SDK receives that signal; committed tool reads pass it to Git subprocesses. No new tool IO starts after cancellation. Provider wrappers are closed in `finally`. Collection remains cooperatively bounded by existing per-operation limits; synchronous JavaScript and non-cooperative injected implementations cannot be forcibly stopped. Cancellation cannot guarantee that a remote server stops processing or billing an already dispatched request. There are no retries that can reset a deadline or budget.

Milestone-3 acceptance/verdict rules are unchanged. An additional conservative live-mode check requires full file evidence, relevant-side source, and every discovered candidate test to have been inspected before `adequate` is possible. Any unavailable/truncated/invalid tool read prevents complete analysis, even if later reads succeed. Reading all bytes still cannot prove the model understood them. Large files, many candidate tests, or incomplete discovery can leave a review partial.

### Trace privacy

Trace export is off by default, including offline evals. SDK defaults are **not private**: the installed runner defaults to tracing enabled and sensitive trace data included. This adapter explicitly disables SDK tracing globally and per runner, removes its export processors, disables SDK sensitive-data logging, and disables HTTP-client logging. These process-wide SDK settings are intentional; do not embed this adapter alongside SDK users that require automatic tracing without isolating processes.

Application spans use trace/span IDs, fixed stage names, duration, status, counts, and allowlisted token usage. They exclude patches, source, prompts, model text, tool payloads, secrets, report paths, and repository paths by default. `--trace-file /path/to/trace.jsonl` explicitly enables local JSONL export; new files use mode 0600. `--trace-sensitive` is a separate opt-in that adds the bounded provider input manifest (including repository paths); it never enables the SDK exporter or key logging. The programmatic `ReviewTrace` API can attach an explicitly supplied bounded sensitive string. No remote/OTLP exporter or dashboard is bundled.

Exporter errors are swallowed and each export wait is capped at 100 ms. A non-cooperative custom exporter can continue after that wait; its owner must implement its own cancellation. Export overhead before agent execution counts against the review deadline. Tracing tests inspect captured spans for sensitive sentinels, and SDK tests verify that only mocked Responses requests occur, with no trace requests.

## GitHub Actions and Checks

Milestone 5 adds a dedicated Node 22 Actions entrypoint (`pnpm github` in a source checkout, or `coverage-review-github` after `pnpm build`). It accepts no repository, owner, pull-request number, base ref, or head ref arguments. Those values come only from the bounded `GITHUB_EVENT_PATH` payload after it is checked against `GITHUB_REPOSITORY`; full 40/64-character commit IDs are retained. For pull requests, the entrypoint validates REST metadata when a token is available and compares the merge base to the trusted PR head. A local `git merge-base` fallback requires `actions/checkout` with `fetch-depth: 0`.

The entrypoint always uses `executeReview`; GitHub does not have its own evidence, acceptance, or verdict policy. Provider-independent GitHub contracts live in `src/github/domain.ts`, REST/SDK response shapes stop in `src/github/rest-client.ts`, and the review agent never receives the GitHub client or token. Publishing happens only after `ReviewResult` validation and never changes that result.

Supported contexts are explicit:

- `pull_request`: supported. Same-repository PRs may use explicitly selected offline or live mode. Fork PRs may use only an explicitly selected offline proposal; an explicit live request is skipped as `needs-review/failed` and is never silently replaced.
- `pull_request_target`: identified but never analyzes or checks out PR code. It writes a failed `needs-review` artifact.
- `merge_group`: metadata is validated and identified, but review execution is not yet supported.
- `workflow_dispatch`: identified, but rejected for analysis because it lacks trusted PR commits.
- all other events: identified as unsupported and written as failed `needs-review` results.

This follows GitHub's current guidance: fork `pull_request` workflows normally receive a read-only token and no secrets, while `pull_request_target` and `workflow_run` are privileged and must not execute or check out untrusted code ([secure use reference](https://docs.github.com/en/actions/reference/security/secure-use), [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions), [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)). Do not enable “send write tokens” or secrets for fork workflows to obtain a live review. A future privileged `workflow_run` publisher must not check out PR code and must validate the included artifact's schema, repository, workflow/event identity, PR number, head SHA, name, path, size, and digest before publishing. `validateArtifactProvenance` supplies the result-level checks but is not a complete artifact-download workflow.

### Inputs, outputs, and artifacts

```sh
# Credential-free/offline. GITHUB_* variables are populated by Actions.
pnpm github -- --offline-review evals/fixtures/review/empty-proposal.json

# Explicitly paid/networked; never selected automatically.
OPENAI_API_KEY=... pnpm github -- --review --provider openai --model <model-id>

# LCOV must have been produced by an earlier user-controlled step.
pnpm github -- --offline-review proposal.json --lcov coverage/lcov.info --coverage-commit <full-head-sha>

# Optional Check publishing (requires GITHUB_TOKEN with checks: write).
GITHUB_TOKEN=... pnpm github -- --offline-review proposal.json --publish-check
```

Inputs are `--offline-review`, explicit `--review --provider openai --model`, optional `--lcov`, `--coverage-commit`, `--timeout-ms`, `--result`, and `--publish-check`. Offline and live are mutually exclusive. Existing local CLI modes and their flags are unchanged. `OPENAI_API_KEY` is read only for an explicit, safe live run. `GITHUB_TOKEN` is optional for read validation and required only to publish a Check. The REST origin is fixed to `api.github.com`; repository and refs cannot be supplied by the model, repository files, or CLI.

The default `coverage-review-result.json` is a versioned `coverage-review-result` envelope containing a runtime-validated `ReviewResult`, validated event context, comparison merge base, and a publishing status that remains separate from the review. It is written atomically, mode 0600, under `GITHUB_WORKSPACE`. Input LCOV/proposal paths must be regular non-symlink files inside the real workspace; directories, escapes, symlinks, malformed data, and oversized files are rejected. LCOV is capped at 16 MiB, proposals/event payloads at 1 MiB, and result artifacts at 4 MiB.

When `GITHUB_OUTPUT` exists, the entrypoint writes only fixed, single-line keys: `verdict`, `analysis-status`, `findings-count`, `rejected-findings-count`, `result-path`, `reviewed-base-sha`, `reviewed-head-sha`, and `publishing-status`. Newlines and NULs are rejected, so values cannot inject extra outputs or workflow commands. Arbitrary model prose is never sent through Actions command files. GitHub likewise recommends file-based handling for arbitrary multiline values ([workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)).

See [offline.yml](examples/workflows/offline.yml), [live-openai.yml](examples/workflows/live-openai.yml), and [external-lcov.yml](examples/workflows/external-lcov.yml). Each example pins Node 22 and pnpm 11.25.0; action major-version tags are illustrative and security-sensitive deployments should pin reviewed action commit SHAs. The standard/offline workflows use no OpenAI credentials. `actions/upload-artifact@v7` uploads an immutable JSON result and reports its SHA-256 digest; GitHub validates that digest when the matching download action retrieves it ([artifact documentation](https://docs.github.com/actions/configuring-and-managing-workflows/persisting-workflow-data-using-artifacts), [upload-artifact](https://github.com/actions/upload-artifact)).

### Check mapping and permissions

The stable Check name is `coverage-review`, bound to the trusted PR head SHA. Conclusions are conservative: complete `adequate` is `success`; `needs-tests` is `failure`; every `needs-review`, partial, or failed result is `neutral`, never success. Only accepted findings become annotations. Severity maps to notice/warning/failure; each annotation uses the validated changed path and line and explicitly labels base/head semantics. A base-side rename finding maps to the validated previous path while the result retains the canonical new path. GitHub Checks has no native base/head-side field, so the side is also carried in the annotation title. Full model prose remains only in the JSON artifact to avoid copying source-like or prompt-like text into API channels.

GitHub permits at most 50 annotations per Check update, so batches are fixed at 50 and total published annotations are capped at 950 (19 requests), with any remainder reported as truncated in the Check summary. The complete validated result remains in the JSON artifact. Summary/title/message sizes and REST responses are bounded. Checks require `checks: write`; PR metadata requires `pull-requests: read`, and commit comparison requires `contents: read`. Uploading with `actions/upload-artifact` in the current run needs no additional repository permission; reading artifacts through the REST API or from another run/repository requires `actions: read`, while deletion/overwrite through token-authenticated artifact APIs requires `actions: write`. Missing/denied permissions yield a sanitized publishing failure and do not alter the review or turn it adequate. See the official [Check Runs API](https://docs.github.com/en/rest/checks/runs), [artifact REST API](https://docs.github.com/en/rest/actions/artifacts), and [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).

REST access is capped at 30 requests, 2 MiB per response, two retries, and fixed repository-scoped endpoints. Only 429/502/503/504 responses retry with bounded exponential backoff; authentication, authorization, validation, and deterministic client errors do not. The review deadline remains the existing executor deadline; GitHub metadata/publishing share an abortable bound of that deadline plus 30 seconds. Abortion prevents new requests and reaches `fetch`, though GitHub may still process a request already received. API bodies, authenticated URLs, headers, tokens, raw provider errors, raw source/patch inputs, prompts, provider payloads, local paths, and report paths are excluded from operational errors, outputs, Check prose, and artifacts. The artifact necessarily retains the bounded, schema-validated proposal prose that is part of `ReviewResult`; it never includes the raw prompt, evidence tool payloads, or provider response envelope. Milestone-4 tracing remains disabled and redacted by default.

Remaining limitations: merge queues and manual dispatch are not reviewable; there is no bundled privileged `workflow_run` artifact downloader/publisher; REST cancellation cannot retract a delivered request; GitHub Checks cannot represent base-side annotations natively; and example third-party actions use major tags rather than immutable SHAs. No tests, repository code, comments, labels, merges, branch writes, or source edits are performed by review analysis.

## Semantic evals

```sh
# Credential-free, network-free harness validation:
pnpm eval:offline
pnpm eval:offline --fixtures boundary,cosmetic,transaction

# Explicitly paid/networked; no live eval was performed for this implementation:
pnpm eval:live --model <model-id> --fixtures boundary,cosmetic,adequate,e2e-only,transaction,misleading,missing-evidence,stale-evidence,truncated-evidence,embedded-instructions --repeats 1 --concurrency 1 --timeout-ms 60000 --max-turns 8 --max-tool-calls 30
```

Versioned `evals/fixtures/semantic/v1/inputs.json` contains thirteen isolated source/test snapshots: boundary/error handling, cosmetic edits, adequate assertions, E2E-only validation, genuine database integration, misleading names/executed lines without assertions, missing/stale/truncated evidence, embedded instructions, Python boundary/relative-import uncertainty, and local freshness. The fixture repository is a fixed in-memory commit-addressed map with content-derived commit IDs. It never executes snapshot code/tests or writes Git. Coverage is synthetic external evidence; fixture diffs replace the whole source body and therefore have broader changed ranges than minimal real Git diffs.

`expected.json` and `scripts.json` are harness-only annotations and canned proposals. Neither is included in the repository map, manifest, tool scope, or live prompt. Live runs create fresh agents per case/repeat. The shared `executeReview` path validates all results before scoring. Eval output includes per-case results, scores, fixture version, prompt/configuration/policy versions, selected model, configured provider limits, and allowlisted usage when available. Failed requests may have no reported usage; null is not zero billing.

Live selection is mandatory and bounded to 20 unique known fixture IDs, 1–5 repeats, concurrency 1–4, and the normal per-run review/provider bounds. Thus at most 100 runs can be selected. Offline defaults to all fixtures. Configuration errors fail the command; individual provider failures become failed case results and remain in aggregates. Eval exit status does not enforce a quality threshold: inspect the machine-readable aggregate. Offline/live evals have no automatic trace export.

### Scoring definitions

The scoring unit is an annotated behavior opportunity per fixture per repeat. Each annotation has a behavior ID, positive (`missing: true`) or negative label, file/side/line interval, literal phrase groups, and acceptable test levels. A positive match requires the location plus at least one case-insensitive phrase from **each** group in the description, reasoning, or suggested test text. IDs and phrase groups are never given to the live model. This intentionally simple deterministic matcher can miss valid paraphrases and match semantically weak text; it is not an LLM judge or proof of behavior.

Maximum-cardinality one-to-one matching pairs accepted findings with expected positives. Duplicate/extra findings remain false positives. Matching is independent of test level, which is scored separately. Rejected proposals/findings are reported independently and cannot earn credit.

| Metric | Definition |
| --- | --- |
| Precision | matched accepted findings / all accepted findings |
| Recall | matched positive opportunities / all positive opportunities |
| False-negative rate | unmatched positive opportunities / all positive opportunities |
| False-positive rate | negative opportunities with any accepted finding in their location / all predefined negative opportunities |
| Test-level accuracy | matched positives with an acceptable level / matched positives |

A denominator of zero yields JSON `null`. FPR is **not** false discovery rate (`FP / all findings`); duplicate findings can reduce precision without multiplying false alarms on a single negative opportunity. Nonmatching findings outside annotated negatives lower precision but do not create arbitrary new negative opportunities. Failed/partial runs keep every positive and negative opportunity in the denominator. Unflagged negatives on failed/partial runs are reported as `unresolvedNegatives`, never true negatives; interpret FPR together with unresolved counts and run failure counts. Empty failed runs therefore earn no positive credit, though their false-alarm rate is zero. Only complete unflagged negatives count as true negatives.

Aggregate metrics sum counts across all selected repeats, including failures. Failed/partial counts, proposal rejections, and verdict distributions are separate from finding quality. A cosmetic `needs-review` caused by absent measurements is not itself a false finding.

The milestone-6 scripted baseline is 13 runs, 6 matched positives, 0 false findings, 0 missed scripted expectations, 6 correct test levels, 0 failed runs, 6 partial runs, and 5 unresolved negatives. Precision/recall/test-level accuracy are 1; FPR/FNR are 0. Verdicts: 6 `needs-tests`, 5 `needs-review`, 2 `adequate`. These numbers demonstrate deterministic harness behavior only. No paid live review/eval was run. Real model quality, model availability, network cancellation, and repeatability remain unmeasured; even pinned model IDs can produce varying findings and usage across runs.

## Milestone 6: hardening and expansion

The starting point is main at `7444fb2` (merged PR #5). The measured bottleneck was repeated comparison resolution: every changed-file patch reran two commit resolutions and a name-status enumeration. `LocalGitDiff` now caches one immutable comparison, orders paths deterministically, and exposes request/byte counters. `ReviewRepository` owns a bounded cache for one review's two snapshots and read limit; no cache survives into another review. Discovery and agent source reads share it. Collection indexes coverage by canonical path instead of repeatedly scanning reports.

### Reproducible baseline

Run `pnpm benchmark:hardening`. `evals/fixtures/hardening/large-monorepo.json` specifies 10 packages, 100 changed sources, and 100 candidate tests. The benchmark creates a disposable repository; its source/tests are never executed. The uncached leg uses fresh adapters per patch to reproduce milestone 5's exact Git operation pattern. This is an operation-path comparison, not a claim that the entire old application was benchmarked. Both legs run in the same process. Recorded output is in `evals/fixtures/hardening/measured.json`.

| Measurement | Uncached baseline | Cached |
| --- | ---: | ---: |
| Changed files / scanned files | 100 / 200 | 100 / 200 |
| Diff Git requests | 403 | 103 |
| Comparison enumerations | 101 | 1 |
| Diff Git output bytes | 292,382 | 24,182 |
| Source reads across two passes | 200 | 100 |
| Source bytes | 4,800 | 2,400 |
| Repeated source reads | 100 | 0 |
| Model tool calls | 0 | 0 |
| Elapsed time on development machine | 5,594 ms | 2,095 ms |
| Process RSS at end of leg | 107,626,496 | 114,196,480 |

Git request count falls 74.4%; source reads fall 50%. Tests assert operation counts, not elapsed time or RSS. RSS is process-wide, includes retained runtime memory between legs, and is not peak memory or evidence of a memory improvement. The benchmark does not measure live provider latency or quality.

### Bounds, pagination, cancellation, and scope

- Git tree/name-status output: 16 MiB; maximum 20,000 enumerated files. Oversized comparison enumeration fails explicitly. Oversized repository listings remain truncated.
- Collection: at most 500 changed-file reads/patches and 16 MiB aggregate patch text. Remaining paths stay in scope with explicit truncated/omitted evidence. Scope JSON includes `evidenceScope.collectedFiles`, `omittedFiles`, `unavailableFiles`, and `truncatedFiles`. Categories can overlap; proposal `reviewedFiles` records what the agent claims to have reviewed and does not make omitted evidence complete.
- Repository session defaults: 4,000 underlying reads, 32 KiB per source, 16 MiB cumulative byte reservations, 4 MiB cache including entry overhead, at most four active reads. Reservations are charged before asynchronous reads; cache hits avoid I/O. Concurrent excess returns truncated rather than opening an unbounded queue. `RepositoryBudgetSchema` validates programmatic bounds; repository JSON cannot raise them.
- `Repository.page` is optional; `ReviewRepository.page` implements it. Pages contain at most 500 paths, with 40 pages per discovery traversal and 400 per session. Cursors bind snapshot identity, prefix, page size, and listing contents. Unknown snapshots, malformed/out-of-range cursors, query changes, and path escapes are rejected. Pagination cannot recover files omitted by the upstream bounded listing. It is internal repository/discovery pagination, not an HTTP service or a new model tool.
- Discovery is sequential, at most 2,000 candidate files per supported language, sharing the cumulative source budget. Each language pass caps source paths at 1,000, imports/candidate and relationships/candidate at 100, and total relationships at 20,000. Excess remains explicitly truncated; file-local evidence retains only relationships relevant to that file. Cancellation is checked before scheduling and passed into Git subprocesses, listings, file reads, discovery, coverage, and tools. Executor deadline defaults to 30 seconds across capture/collection/agent; subprocesses also have 30-second caps. Non-cooperative injected adapters and synchronous parsing cannot be forcibly preempted; parser size/work bounds remain necessary.
- Proposals are never silently truncated. Every omitted, unavailable, unsupported, stale, ambiguous, rejected, or truncated path remains conservative: accepted findings imply `needs-tests`; no findings with uncertainty imply `needs-review`. Budgets never produce `adequate`.

### Monorepo configuration and coverage

Both local and GitHub entrypoints accept explicit `--config <path>`. No configuration is auto-discovered or executed. Local config paths are caller-selected; Actions config and all configured report paths are workspace-contained, regular, non-symlink files. JSON is capped at 64 KiB, depth 16, rejects duplicate keys, and is runtime-validated. Unknown keys, overlapping package/source roots, paths outside packages, and unsafe paths are rejected. Relative paths inside the document are repository-relative, not relative to the config file. At most 50 packages, 20 source roots per package, and 20 reports are accepted.

```json
{
  "schemaVersion": "1",
  "packages": [
    { "root": "packages/web", "sourceRoots": ["packages/web/src"] },
    { "root": "packages/service", "sourceRoots": ["packages/service/src"] }
  ],
  "reports": [
    { "path": "coverage/web.info", "format": "lcov", "root": "packages/web" },
    { "path": "coverage/service.json", "format": "coverage-py-json", "root": "packages/service/src" }
  ]
}
```

Add `commitSha` with the full reviewed head to each report only when generated by a trusted external step for that commit. A report `root` prefixes its relative source paths: `src/value.ts` plus `packages/web` becomes `packages/web/src/value.ts`. Coverage.py `value.py` plus `packages/service/src` becomes `packages/service/src/value.py`. Omit root for already repository-relative paths. There is no basename fallback. Package roots restrict name/location hints; static relative TS/JS imports may still establish cross-package relationships. Python source roots define import-module lookup. Changed sources outside configured roots remain in the review and produce discovery uncertainty.

`--config` and legacy `--lcov`/`--coverage-commit` are mutually exclusive; there is no implicit merge or precedence override. Legacy single-LCOV invocation remains supported. Config cannot contain credentials, providers, endpoints, publishing permissions, event identity, scripts, plugins, or resource-limit overrides.

`MultipleCoverageProvider` preserves each report's format, root, declared commit, digest (when successfully parsed), consumed bytes, status, freshness, and diagnostics. Reports have 16 MiB individual and 32 MiB aggregate byte budgets, plus 200,000 aggregate file/line/branch records. Failed reads consume their byte reservation. Inputs exceeding a budget become explicit truncated reports. LCOV has a 200,000 input-line parser bound; JSON depth and token-delimiter bounds cover even ignored metadata.

Identical report bytes with the same format, root, and commit metadata are idempotent; duplicate inputs remain identified in provenance but do not add hits. Identical file measurements across distinct reports are also idempotent. Differing overlapping file measurements remove that file's aggregate measurements and produce a conflict diagnostic; order cannot choose a winning count. A stale, incomplete, or malformed report makes the aggregate uncertain, even when another report is fresh. This is intentionally conservative across the whole review, including unrelated reports; per-file relevance-based relaxation is deferred.

Coverage.py JSON format **3** is the additional format, selected for the mixed-language monorepo fixture. The official [JSON command documentation](https://coverage.readthedocs.io/en/latest/commands/cmd_json.html) and [7.6.1 reporter implementation](https://github.com/nedbat/coveragepy/blob/7.6.1/coverage/jsonreport.py) specify the format marker, executed/missing/excluded lines, and executed/missing branch arcs. Executed/missing values become boolean 1/0 measurements, not execution frequencies. Excluded or absent lines remain absent; they are never invented as covered. Branch-disabled reports carry uncertainty; branch-enabled reports must include both arc arrays. Unknown format versions, duplicate/conflicting lines/arcs/object keys, malformed paths, and malformed data are rejected. Summary, context, function, and class metadata do not supply additional behavioral evidence. No `.coverage` database, XML, universal JSON, or coverage generation is supported. LCOV unknown `BRDA` hits now preserve both `hits: null` and `covered: null`; measured zero remains `0/false`.

### Python discovery

`PythonTestDiscovery` recognizes `test_*.py` and `*_test.py` filenames (pytest/unittest-style conventions) and simple absolute `import module` / `from module import ...` statements. Module names are mapped only against changed source paths under configured source roots, or repository root when no packages are supplied. Multiple matches remain ambiguous. Names and co-location never cross configured package boundaries; explicit unambiguous static imports can.

This is bounded lexical discovery, not a Python interpreter or AST parser. Dynamic imports, relative imports, multiline/triple-quoted syntax, unresolved modules, and aliases retain uncertainty. Test level requires explicit `unit`, `integration`, or `e2e` path segments; otherwise it is unknown. No assertion coverage is inferred from import/name/execution evidence. JS/TS non-relative imports now also retain explicit unresolved-import uncertainty. Unsupported languages continue to prevent adequate analysis. No runtime plugin system was introduced.

### Staged and unstaged review

```sh
pnpm dev --repo /path/to/repo --staged --offline-review /path/to/proposal.json --json
pnpm dev --repo /path/to/repo --unstaged --offline-review /path/to/proposal.json --config /path/to/review.json --json
# Explicit provider invocation, only when a paid live review is intended:
pnpm dev --repo /path/to/repo --staged --review --provider openai --model <model-id>
```

`--staged` compares HEAD with a captured index; `--unstaged` compares a captured index with captured tracked working-tree files. Partially staged files therefore produce different, correct comparisons. Untracked files are excluded, including potential untracked tests. Modes require offline/live review and reject each other and `--base`, `--head`, `--file`, or `--evidence`. Incompatible flags are rejected before provider construction. Actions accepts neither local mode and continues to use validated commits.

Capture reads blob objects and regular files into an immutable bounded map. Diff hunks are generated from that map with `git diff --no-index` over private temporary files; the temporary data is deleted afterward. It never stages, writes Git objects, commits, changes the index, or alters working-tree content. Paths are checked for containment/symlinks, file descriptors and metadata are checked, and index/HEAD plus working content are checked again after capture. Concurrent modifications retry once; continued instability, conflicts, oversized/unsafe inputs, or exhausted time return structured failed reviews. This detects observed concurrent edits, not an atomic filesystem transaction against an adversarial writer. Run against a stable user-controlled working tree.

Capture limits are 2,000 tree/index entries per snapshot, 32 KiB per regular source, 32 MiB cumulative source bytes including verification/retries, 10,000 Git requests, 500 changed files, two attempts, and 30 seconds (also bounded by the executor). Unsupported staged symlinks are retained without following targets; unsafe tracked working-tree symlinks fail capture. Binary/non-UTF-8 content is unavailable for line review. Exact-content renames preserve canonical new paths and old base-side paths. Edited renames and ambiguous identical-content rename candidates are represented as additions/deletions, not guessed. Unstaged renames to untracked destinations appear as tracked deletions because the destination is outside scope. Submodules, sparse-directory index entries, and unborn HEAD are explicit unsupported/failed captures.

Staged base identity is the real HEAD SHA. Captured index/working identities use `local:<sha256>` over canonical paths, modes, and content digests; they are **not Git commits**. Diffs, source, tests, tools, and references use the same captured maps. Commit coverage metadata cannot establish local freshness; the executor forces local coverage to unverifiable even for an injected provider claiming a match.

### Schema compatibility and telemetry

Commit results/evidence continue to use schema v1 and `ev1:` references; old v1 artifacts/fixtures remain readable. Current v1 parsers additionally accept optional `scope.evidenceScope` and per-report evidence provenance/format fields. Old strict consumers must upgrade to the current schemas before consuming newly emitted optional fields; unknown fields are rejected explicitly, never silently reinterpreted.

Local results/evidence use schema v2, `ev2:` references, and `provenance.snapshotMode` (`staged` or `unstaged`). `evidenceSchemaVersion` matches the result version. Consumers must dispatch on the version and treat local identities as opaque content IDs; do not place them in Git commands. Proposals remain v1 and contain no verdict. New executor/policy provenance versions are 2; the provider prompt version is coverage-review-2. CI artifact envelope stays v1 and rejects local v2 results or mismatched identity versions; no migration can turn a local snapshot into a publishable commit artifact. Regenerate evidence references when any snapshot or evidence changes.

Tracing remains opt-in, with no external service dependency or SDK exporter. Allowlisted stages now include capture, discovery, coverage parsing, collection, agent, validation, review, and publishing. Counts include scanned files, reads, reserved/read bytes, cache hits, pages, truncations, and diff requests where available. `ReviewTrace` supports an injected clock and in-memory exporters. Default spans contain no paths, source, patches, prompts, credentials, raw exceptions, model prose, or provider payloads. Existing separately requested sensitive-manifest tracing remains bounded. Publishing status stays separate from the underlying result, including in telemetry.

No measured need justified a second privileged publisher. Existing opt-in Checks remain the only publishing workflow; creating a Check requires Checks write permission and a commit head ([official REST documentation](https://docs.github.com/en/rest/checks/runs#create-a-check-run)). A future artifact-download publisher would require independent trusted API validation of workflow/run/attempt/PR/head/artifact identity and bounded download/archive handling. The existing result-level provenance helper is not that workflow. No such elevated artifact consumer was added; no PR comments, labels, merges, releases, or branch mutation were introduced.

Additional validation: `pnpm benchmark:hardening`, `pnpm eval:offline`, `pnpm action:smoke`, and CLI help checks supplement typecheck, lint, tests, and production build. Semantic fixtures keep expected labels/scripts outside agent-visible evidence. New local integration tests cover partial staging, isolation, concurrent edits, conflicts, renames/deletions, binary files, symlinks, identity, and freshness. Real-model quality and live publishing remain unmeasured; no paid calls or real Checks are part of validation.
