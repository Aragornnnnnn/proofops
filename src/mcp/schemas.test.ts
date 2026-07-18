// MCP 도구 입력값의 길이와 증거 URL 제한을 검증한다
import { describe, expect, it } from "vitest";
import {
  createNotionIssueInputSchema,
  linkPullRequestInputSchema,
  recordProgressInputSchema,
  requestVerificationInputSchema,
  startTaskInputSchema,
} from "./schemas";

describe("recordProgressInputSchema", () => {
  it("1,000자를 초과하는 요약을 거부한다", () => {
    expect(
      recordProgressInputSchema.safeParse({
        taskId: "task-1",
        kind: "test",
        summary: "a".repeat(1_001),
      }).success,
    ).toBe(false);
  });

  it.each(["ftp://example.com/evidence", "file:///tmp/evidence"]) (
    "http 또는 https가 아닌 증거 URL을 거부한다",
    (evidenceUrl) => {
      expect(
        recordProgressInputSchema.safeParse({
          taskId: "task-1",
          kind: "test",
          summary: "테스트를 통과했다.",
          evidenceUrl,
        }).success,
      ).toBe(false);
    },
  );
});

describe("external mutation operationId", () => {
  it.each([
    [startTaskInputSchema, { notionPageIdOrUrl: "page-id" }],
    [linkPullRequestInputSchema, { taskId: "task-1", pullRequestUrl: "https://github.com/Aragornnnnnn/landit-be/pull/1" }],
    [requestVerificationInputSchema, { taskId: "task-1", repository: "Aragornnnnnn/landit-be", environment: "develop", commitSha: "a".repeat(40) }],
    [createNotionIssueInputSchema, { title: "이슈", impact: "영향", evidence: [{ label: "근거", url: "https://example.com/evidence" }], causeOrHypothesis: "가설", scope: ["API"], acceptanceCriteria: ["완료"] }],
  ] as const)("operationId가 없거나 UUID가 아니면 거부한다", (schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
    expect(schema.safeParse({ ...input, operationId: "not-a-uuid" }).success).toBe(false);
    expect(schema.safeParse({ ...input, operationId: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
  });
});
