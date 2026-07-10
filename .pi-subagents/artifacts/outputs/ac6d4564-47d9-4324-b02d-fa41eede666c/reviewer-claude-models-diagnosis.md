## Review

- Correct: Anthropic-looking `/v1/models` requests are intended to select Claude providers. `detectResponseFormat()` treats the presence of `anthropic-version` as `anthropic` (`src/app/v1/_lib/models/available-models.ts:132`), maps that to client format `claude` (`src/app/v1/_lib/models/available-models.ts:171`), and `getProviderTypesForFormat("claude")` returns both `claude` and `claude-auth` (`src/app/v1/_lib/models/available-models.ts:326`). Plain OpenAI-style `/v1/models` also deliberately includes `claude`/`claude-auth` in `PLAIN_OPENAI_MODEL_PROVIDER_TYPES` (`src/app/v1/_lib/models/available-models.ts:23`). Provider selection by response format is therefore not the most likely root cause.
- Correct: A configured exact `allowedModels` entry works for the narrow unit-tested path. The existing test uses a `claude` provider with `allowedModels: ["claude-sonnet-4-20250514"]` and asserts the model is returned (`tests/unit/proxy/available-models.test.ts:132`).
- Fixed: none. This was a read-only diagnosis; no source or test files were modified.
- Blocker: High - Claude model-list upstream auth is inconsistent with the main proxy path, so a configured provider can work for chat/messages while `/v1/models` returns an empty list. In `available-models.ts`, the Claude upstream config always sends only `x-api-key` plus `anthropic-version` (`src/app/v1/_lib/models/available-models.ts:209`) and maps both `claude` and `claude-auth` to that same config (`src/app/v1/_lib/models/available-models.ts:300`). The main proxy path instead calls `resolveAnthropicAuthHeaders()` with `forceBearerOnly` for `claude-auth` (`src/app/v1/_lib/proxy/forwarder.ts:5034`), and that helper returns bearer-only for `claude-auth` or proxy-like Anthropic URLs, x-api-key only for AWS external Anthropic, and both headers otherwise (`src/app/v1/_lib/headers.ts:70`). A `claude-auth` provider or Anthropic-compatible relay that expects `Authorization: Bearer ...` will reject the model-list request, `fetchModelsFromProvider()` catches the error and returns `[]` (`src/app/v1/_lib/models/available-models.ts:315`), and the handler serializes that as an empty Anthropic response (`src/app/v1/_lib/models/available-models.ts:583`). Minimal fix: build Claude model-list auth headers through `resolveAnthropicAuthHeaders(provider.key, urlOrBaseUrl, { forceBearerOnly: provider.providerType === "claude-auth" })`, then add `anthropic-version` without overriding the auth decision. Add tests for `claude-auth`, proxy-like Anthropic URLs, official Anthropic, and AWS external Anthropic model listing.
- Blocker: High - non-exact `allowedModels` rules can produce an empty list without any upstream request. Provider model rules explicitly support `exact`, `prefix`, `suffix`, `contains`, and `regex` (`src/types/provider.ts:55`; `src/lib/allowed-model-rules.ts:8`), and routing honors those rules via `matchesAllowedModelRules()` (`src/app/v1/_lib/proxy/provider-selector.ts:81`). The models endpoint, however, short-circuits whenever `provider.allowedModels.length > 0`, filters to `matchType === "exact"`, and returns only exact patterns (`src/app/v1/_lib/models/available-models.ts:290`). If an admin configures a natural Claude whitelist such as `{ matchType: "prefix", pattern: "claude-" }`, chat routing can work but `/v1/models` returns `[]`. Minimal fix: normalize rules once; include exact rules directly, and for non-exact rules fetch upstream models and filter with `matchesAllowedModelRules()`. If upstream fetch fails and no exact rules exist, log/return a diagnostic rather than silently emitting an empty list. Add tests for prefix/regex-only rules and mixed exact + prefix rules.
- Note: Medium - provider URLs that include an endpoint path can be duplicated by the model-list fetcher. `fetchModelsWithConfig()` only trims a trailing slash and then appends the provider-specific model path (`src/app/v1/_lib/models/available-models.ts:251`); Claude uses `${baseUrl}/v1/models` (`src/app/v1/_lib/models/available-models.ts:209`). The main proxy path has `buildProxyUrl()` specifically to avoid duplicating complete endpoint paths or version roots (`src/app/v1/_lib/url.ts:95`) and uses it for normal forwarding (`src/app/v1/_lib/proxy/forwarder.ts:2726`). If a deployed provider URL is stored as `https://example.com/v1/messages`, the models endpoint will request `https://example.com/v1/messages/v1/models`, causing an upstream 404 and then `[]`. Minimal fix: construct model-list URLs with the same URL-normalization/building helper or a shared model-list URL helper that understands origin, version root, and full endpoint URLs. Add tests for `https://api.anthropic.com`, `https://api.anthropic.com/v1`, and `https://api.anthropic.com/v1/messages`.
- Note: Medium - all upstream/model enumeration failures collapse into a successful empty response. Non-200 upstream responses throw (`src/app/v1/_lib/models/available-models.ts:268`), but `fetchModelsFromProvider()` catches every error and returns an empty array (`src/app/v1/_lib/models/available-models.ts:315`). Aggregation then logs `modelCount: 0` and returns HTTP 200 with empty `data`/`models` (`src/app/v1/_lib/models/available-models.ts:488`; `src/app/v1/_lib/models/available-models.ts:583`). I did not find the literal string `No models fetched from upstream` in the inspected repo path, so the observed client message is likely client-side interpretation of CCH's empty model list. Minimal fix: track per-provider fetch outcomes; if providers matched but every upstream fetch failed and there are no configured exact models, return a 502-style upstream error or at least include structured server logs with provider id/type/status and safe URL host. Add tests for matched providers where all upstream calls fail.
- Note: Low/Config - provider group and active-time filters can also yield no matched providers. The model-list path filters by `p.isEnabled`, provider type, active schedule, and `checkProviderGroupMatch()` when the user/key has an effective group (`src/app/v1/_lib/models/available-models.ts:450`). That can explain an empty response if the CCH token's provider group does not intersect the Claude provider `groupTag`, but it is less likely than the code-level fetch/enumeration issues because the user reports a configured Claude provider and a valid CCH token. Add one regression test that a default/null provider group behaves consistently with the main selector, and one negative test for a mismatched group.

## Likelihood Order

1. `claude-auth` or Anthropic-compatible proxy/relay provider: `/v1/messages` works, `/v1/models` fails because the model-list path does not reuse `resolveAnthropicAuthHeaders()`.
2. Claude provider has non-exact `allowedModels` rules: routing works, but model listing filters all configured rules away.
3. Provider URL contains `/v1`, `/v1/messages`, or another endpoint path: the model-list path appends `/v1/models` naively.
4. Upstream supports chat/messages but not model listing, or transiently rejects the list call: CCH hides the failure and returns empty `data`.
5. Group/time configuration excludes the provider for this CCH token.

## Minimum Fix Set

- Replace the Claude `buildHeaders` logic in `UPSTREAM_CONFIGS.claude` with the shared `resolveAnthropicAuthHeaders()` behavior and preserve `anthropic-version`.
- Change `fetchModelsFromProvider()` so non-exact allowed model rules do not short-circuit to an empty list. Use upstream enumeration plus `matchesAllowedModelRules()` for pattern rules, while still returning exact rules directly.
- Replace naive `${baseUrl}/v1/models` construction with shared URL construction that handles origin, version root, and full endpoint provider URLs.
- Preserve compatibility, but stop treating "matched providers + all fetches failed" as indistinguishable from "there are genuinely no models" in logs/tests.

## Tests To Add

- `handleAvailableModels` with `anthropic-version`, provider type `claude-auth`, `allowedModels: null`, mocked upstream success: assert Anthropic schema and `Authorization`-based upstream auth.
- `handleAvailableModels` with `claude` provider and proxy-like Anthropic URL: assert auth headers follow `resolveAnthropicAuthHeaders()`.
- `handleAvailableModels` with AWS external Anthropic URL: assert x-api-key-only behavior is preserved.
- `allowedModels` prefix-only and regex-only cases: mocked upstream returns mixed models; assert only matching Claude models are listed.
- Mixed exact + prefix rules: assert exact models are included and upstream-matched models are merged/deduped.
- Provider URL normalization: base origin, `/v1`, and `/v1/messages` variants should all fetch the intended model-list endpoint.
- All upstream fetches fail with matched providers: assert the chosen behavior, either explicit upstream error or empty response with structured warning, so the regression is deliberate.

## Residual Risks

- I did not run live upstream calls and did not inspect any real deployment secrets or tokens.
- I did not run the Vitest suite; this diagnosis is based on static inspection of the requested files plus directly related auth/URL helpers.
- The user's exact provider type, provider URL, allowed model rules, group tag, and upstream status are unknown, so the ranking is based on code paths that can produce the reported empty model-list symptom.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings include High severity auth/header mismatch at src/app/v1/_lib/models/available-models.ts:209 and src/app/v1/_lib/proxy/forwarder.ts:5034, High severity non-exact allowedModels empty-list behavior at src/app/v1/_lib/models/available-models.ts:290, and Medium severity URL-construction risk at src/app/v1/_lib/models/available-models.ts:251."
    }
  ],
  "changedFiles": [
    ".pi-subagents/artifacts/outputs/ac6d4564-47d9-4324-b02d-fa41eede666c/reviewer-claude-models-diagnosis.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read requested files: src/app/v1/_lib/models/available-models.ts, tests/unit/proxy/available-models.test.ts, src/lib/allowed-model-rules.ts, src/types/provider.ts",
      "result": "passed",
      "summary": "Inspected model-list implementation, existing tests, allowed-model rules, and provider types."
    },
    {
      "command": "grep for No models fetched from upstream, handleAvailableModels, providerType, allowedModels, claude-auth, and Anthropic auth references",
      "result": "passed",
      "summary": "The literal client error string was not found; related auth and model-list paths were identified."
    },
    {
      "command": "awk line-reference excerpts for available-models.ts, headers.ts, provider-selector.ts, url.ts, forwarder.ts, providers.ts, provider.ts, and allowed-model-rules.ts",
      "result": "passed",
      "summary": "Collected line-number evidence for the ranked findings."
    },
    {
      "command": "git diff --name-only --cached && git status --short",
      "result": "passed",
      "summary": "No staged files; worktree has untracked .ccg/ and .pi-subagents/ paths."
    }
  ],
  "validationOutput": [
    "Static read-only diagnosis completed; no live upstream requests and no tests were run.",
    "No real tokens were read or printed."
  ],
  "residualRisks": [
    "Exact deployed provider type, URL, allowedModels rules, group tag, and upstream behavior are unknown.",
    "Findings are ranked from code evidence and may need deployment configuration/log confirmation."
  ],
  "noStagedFiles": true,
  "diffSummary": "No source diff; wrote the requested diagnosis artifact only.",
  "reviewFindings": [
    "blocker/high: src/app/v1/_lib/models/available-models.ts:209 - Claude model-list upstream auth does not reuse resolveAnthropicAuthHeaders, so claude-auth/proxy-like providers can fail and return an empty list.",
    "blocker/high: src/app/v1/_lib/models/available-models.ts:290 - non-exact allowedModels rules are filtered out after short-circuiting upstream fetch, producing zero listed models.",
    "note/medium: src/app/v1/_lib/models/available-models.ts:251 - model-list URL construction naively appends /v1/models and can duplicate endpoint paths.",
    "note/medium: src/app/v1/_lib/models/available-models.ts:315 - upstream failures are swallowed into [] and serialized as a successful empty model list."
  ],
  "manualNotes": "Read-only task honored for source files. The only written file is the required artifact."
}
```
