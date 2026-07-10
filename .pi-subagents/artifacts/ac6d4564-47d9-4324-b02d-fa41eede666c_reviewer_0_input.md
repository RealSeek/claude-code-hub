# Task for reviewer

[Read from: E:\GitCode\claude-code-hub\src\app\v1\_lib\models\available-models.ts, E:\GitCode\claude-code-hub\tests\unit\proxy\available-models.test.ts, E:\GitCode\claude-code-hub\src\lib\allowed-model-rules.ts, E:\GitCode\claude-code-hub\src\types\provider.ts]

只读诊断这个 bug：用户请求部署后的 CCH /v1/models（Claude/Anthropic 客户端，带有效 CCH token）时，客户端提示 `No models fetched from upstream`；用户已配置 Claude provider。请检查 `src/app/v1/_lib/models/available-models.ts`、`tests/unit/proxy/available-models.test.ts`、provider 相关类型/规则，按可能性排序给出根因、证据、最小修复建议和需要补充的测试。不要修改文件。注意不要使用或输出真实 token。

---
**Output:**
Write your findings to exactly this path: E:\GitCode\claude-code-hub\.pi-subagents\artifacts\outputs\ac6d4564-47d9-4324-b02d-fa41eede666c\reviewer-claude-models-diagnosis.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```