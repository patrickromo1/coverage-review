# coverage-review

A TypeScript CLI for collecting deterministic evidence about changed code, candidate tests, and externally generated coverage. Milestone 4 adds an explicitly selected OpenAI Agents SDK reviewer and deterministic semantic evals on top of the shared executor and conservative verdict policy. Offline modes remain credential-free.

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

- Test discovery supports JavaScript and TypeScript conventions only. Static relationships recognize relative ESM imports/exports and literal CommonJS `require` calls. It does not execute configuration, resolve aliases, package exports, generated tests, dynamic imports, or framework-specific dependency injection.
- Generic `*.test.*` and `*.spec.*` files have level `unknown`; location/name signals are intentionally conservative. Discovery does not inspect assertions and cannot establish behavioral adequacy.
- LCOV has no standard commit field. Reports are `unverifiable` unless `--coverage-commit` is supplied, and `stale` when supplied metadata differs from the reviewed head. Evidence still exposes measurements with that freshness state rather than silently accepting them as current.
- Only LCOV `SF`, `DA`, and `BRDA` details are used. Summary and function records are ignored. Malformed records, paths outside the repository, duplicate normalized source records, missing files, oversized reports, and unavailable reports are surfaced explicitly.
- Line and branch evidence is filtered to changed head lines. Deleted files and binary changes have no applicable head-line coverage. Pure renames may have no changed lines.
- Git filenames are decoded as UTF-8; arbitrary non-UTF-8 filename bytes are unsupported. Submodule and non-blob sources are reported as unsupported source evidence.
- The tool never executes repository tests or code. GitHub APIs, publishing, and Actions integration remain out of scope.

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

The deadline covers collection and agent invocation together. Timeout returns a failed result and aborts the agent signal. In-process cancellation is cooperative: a non-cooperative promise or collector may keep running after the executor returns, and synchronous JavaScript cannot be preempted (elapsed deadlines are checked when it returns). Provider adapters must enforce their own transport/resource bounds. The application never runs repository tests, writes repository source, modifies Git, or publishes review results.

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

## Semantic evals

```sh
# Credential-free, network-free harness validation:
pnpm eval:offline
pnpm eval:offline --fixtures boundary,cosmetic,transaction

# Explicitly paid/networked; no live eval was performed for this implementation:
pnpm eval:live --model <model-id> --fixtures boundary,cosmetic,adequate,e2e-only,transaction,misleading,missing-evidence,stale-evidence,truncated-evidence,embedded-instructions --repeats 1 --concurrency 1 --timeout-ms 60000 --max-turns 8 --max-tool-calls 30
```

Versioned `evals/fixtures/semantic/v1/inputs.json` contains ten isolated source/test snapshots: boundary/error handling, cosmetic edits, adequate assertions, E2E-only validation, genuine database integration, misleading names/executed lines without assertions, missing/stale/truncated evidence, and embedded instructions. The fixture repository is a fixed in-memory commit-addressed map with content-derived commit IDs. It never executes snapshot code/tests or writes Git. Coverage is synthetic external evidence; fixture diffs replace the whole source body and therefore have broader changed ranges than minimal real Git diffs.

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

The measured scripted baseline is 10 runs, 5 matched positives, 0 false findings, 0 missed scripted expectations, 5 correct test levels, 4 partial runs, and 3 unresolved negatives. Precision/recall/test-level accuracy are 1; FPR/FNR are 0. Verdicts: 5 `needs-tests`, 3 `needs-review`, 2 `adequate`. These numbers demonstrate deterministic harness behavior only. No paid live review/eval was run. Real model quality, model availability, network cancellation, and repeatability remain unmeasured; even pinned model IDs can produce varying findings and usage across runs.
