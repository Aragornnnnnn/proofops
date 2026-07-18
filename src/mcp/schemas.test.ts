// MCP 도구 입력값의 길이와 증거 URL 제한을 검증한다
import { describe, expect, it } from "vitest";
import { recordProgressInputSchema } from "./schemas";

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
