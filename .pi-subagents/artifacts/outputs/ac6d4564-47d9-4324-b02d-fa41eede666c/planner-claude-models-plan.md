# Implementation Plan

## Goal
Make `/v1/models` return a useful Claude model list even when a `claude`/`claude-auth` provider has no `allowedModels` and its Anthropic-compatible upstream does not implement `/v1/models`.

## Minimal Diagnosis
Root cause is valid. In `src/app/v1/_lib/models/available-models.ts`, Claude providers with non-empty `allowedModels` return configured exact rules directly, but empty `allowedModels` falls through to `UPSTREAM_CONFIGS.claude`, which calls `${provider.url}/v1/models`. If that upstream endpoint returns 404/405/etc. or cannot be reached, `fetchModelsFromProvider` catches the error and returns `[]`; aggregation then returns an empty model list. A Claude/Anthropic client can report that as `No models fetched from upstream`.

Evidence:
- `src/app/v1/_lib/models/available-models.ts:209-211`: Claude upstream config builds `${baseUrl}/v1/models` with Anthropic headers.
- `src/app/v1/_lib/models/available-models.ts:290-297`: configured `allowedModels` are used only when present, and only exact rules are listable.
- `src/app/v1/_lib/models/available-models.ts:315-319`: upstream fetch failures are swallowed and converted to `[]`.
- `src/app/v1/_lib/models/available-models.ts:475-477`: all matched provider results are aggregated from `fetchModelsFromProvider`; if each returns `[]`, the endpoint returns an empty list.
- `src/app/v1/_lib/models/available-models.ts:583-585`: Anthropic-format requests still serialize the same empty model array.
- `tests/unit/proxy/available-models.test.ts:140-151`: existing coverage only proves the configured `allowedModels` path, not the empty-allowedModels/upstream-failure path.
- Search found no CCH source log/error string exactly named `No models fetched from upstream`; this is likely the client-visible interpretation of CCH returning an empty model list, not a server-side string in the checked source.

## Tasks
1. **Add a Claude-only static fallback list**: Define a small `CLAUDE_FALLBACK_MODELS: FetchedModel[]` constant in `src/app/v1/_lib/models/available-models.ts` near `UPSTREAM_CONFIGS`.
   - File: `src/app/v1/_lib/models/available-models.ts`
   - Changes: Include conservative public Claude IDs already expected by CCH/users, for example current Sonnet/Opus/Haiku IDs. Do not include credentials or provider-specific private aliases.
   - Acceptance: The constant is used only for `providerType === "claude" || providerType === "claude-auth"`.

2. **Return fallback after Claude upstream failure or empty upstream result**: In `fetchModelsFromProvider`, keep the existing priority order: exact `allowedModels` first, then upstream fetch. For Claude provider types only, if upstream fetch throws or returns an empty array, return `CLAUDE_FALLBACK_MODELS`; for non-Claude types keep current `[]` behavior.
   - File: `src/app/v1/_lib/models/available-models.ts`
   - Changes: Add a helper such as `getFallbackModelsForProvider(provider)` and use it in the `try`/`catch`. Log at debug/warn without tokens.
   - Acceptance: Official/upstream-supported `/v1/models` responses still win when non-empty; fallback is only a compatibility safety net.

3. **Add regression coverage for Claude provider without allowedModels and missing upstream models endpoint**: Mock `undici.request` to return a non-200 status for a `claude` provider with `allowedModels: []` or `null`.
   - File: `tests/unit/proxy/available-models.test.ts`
   - Changes: Add hoisted `undici` mock or equivalent local mock before importing `handleAvailableModels`.
   - Acceptance: `handleAvailableModels` returns `200` and a non-empty Anthropic response when request has `anthropic-version`; response contains no real tokens.

4. **Add scoped behavior tests**: Add one test proving a successful Claude upstream response is preserved, and one test proving an `openai-compatible` upstream failure still returns empty rather than Claude fallback.
   - File: `tests/unit/proxy/available-models.test.ts`
   - Changes: Configure mock providers and `undici.request` responses per case.
   - Acceptance: Fallback does not mask real upstream model lists and does not affect non-Claude providers.

5. **Run focused validation**: Execute the available-models unit test file and optionally full unit tests if time permits.
   - File: `tests/unit/proxy/available-models.test.ts`
   - Changes: None beyond tests.
   - Acceptance: `vitest run tests/unit/proxy/available-models.test.ts` passes; full `pnpm test`/project test command can be run separately if desired.

## Files to Modify
- `src/app/v1/_lib/models/available-models.ts` - add Claude fallback model list and use it only when Claude upstream model discovery fails or is empty.
- `tests/unit/proxy/available-models.test.ts` - add regression tests for empty `allowedModels` plus missing Claude upstream `/v1/models`, successful upstream preservation, and non-Claude scoping.

## New Files
- None.

## Dependencies
Task 2 depends on Task 1. Tasks 3 and 4 depend on Task 2. Task 5 depends on test changes.

## Risks
- A static fallback can advertise models unsupported by a particular third-party Claude proxy. This is already consistent with the current routing semantics where empty `allowedModels` means “accept any model”, but admins with strict support should configure exact `allowedModels`.
- The fallback list can become stale. Keep it small and conservative, and continue preferring configured exact `allowedModels` and successful upstream responses.
- Existing code only lists exact `allowedModels`; prefix/regex/suffix/contains rules cannot be expanded into concrete IDs. This plan does not change that behavior.
- Test setup may need an `undici` mock added before module import because `available-models.ts` imports `request` directly.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read the requested source/test files, verified the Claude empty-allowedModels path falls through to upstream /v1/models and returns [] on failure, then produced a concise minimal repair plan and residual risks."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "functions.read on available-models.ts, available-models.test.ts, provider-selector.ts, allowed-model-rules.ts, provider.ts",
      "result": "passed",
      "summary": "Inspected relevant model listing, provider selection, allowed model rule, and provider type code."
    },
    {
      "command": "functions.grep for No models fetched from upstream and model-list code paths",
      "result": "passed",
      "summary": "Found no source string for the client message; confirmed upstream failure and empty aggregation paths."
    }
  ],
  "validationOutput": [
    "No source edits were made. The diagnosis is based on static code inspection of the requested files plus provider type context."
  ],
  "residualRisks": [
    "Static Claude fallback may list a model unsupported by a specific third-party proxy unless admins configure exact allowedModels.",
    "Git staging state was not inspected with shell because this subagent only had read/grep/find/ls/write tools available."
  ],
  "noStagedFiles": false,
  "diffSummary": "No source diff; wrote this read-only analysis artifact only.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "No real tokens were used or output. Existing test fixture strings are placeholders only."
}
```