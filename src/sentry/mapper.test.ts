// Sentry 원문에서 안전한 사건 근거만 추출하는 매퍼와 클라이언트를 검증한다
import { describe, expect, it, vi } from "vitest";
import fixture from "../../test/fixtures/sentry-issue.json";
import sensitiveTextFixture from "../../test/fixtures/sentry-issue-sensitive-text.json";
import { SentryClient } from "./client";
import { mapSentryIssue } from "./mapper";

describe("mapSentryIssue", () => {
  it("허용된 사건 근거와 링크만 추출한다", () => {
    expect(mapSentryIssue(fixture)).toEqual({
      issueId: "12345",
      title: "TypeError: Cannot read properties of undefined",
      culprit: "GET /api/v1/scenarios",
      firstSeen: "2026-07-17T00:00:00Z",
      lastSeen: "2026-07-18T00:00:00Z",
      count: 42,
      affectedUsers: 7,
      release: "proofops@1.2.3",
      topStackFrames: [
        { filename: "src/routes/scenarios.ts", function: "getScenarios", line: 42, column: 7 },
        { filename: "src/services/scenario.ts", function: "list", line: 18, column: 3 },
      ],
      evidence: [
        { label: "Sentry issue", url: "https://sentry.io/organizations/landit/issues/12345/" },
        { label: "Latest Sentry event", url: "https://sentry.io/organizations/landit/issues/12345/events/abc123/" },
      ],
      observationLimit: "Sentry issue metadata and the latest event were read; no root-cause conclusion was made.",
    });
  });

  it("인증 정보, 요청 본문, 쿠키, 사용자 이메일과 지역 변수를 반환하지 않는다", () => {
    const evidence = JSON.stringify(mapSentryIssue(fixture));

    for (const forbidden of [
      "Authorization",
      "event-secret",
      "requestBodySecret",
      "Cookie",
      "user@example.com",
      "localSecret",
    ]) {
      expect(evidence).not.toContain(forbidden);
    }
  });

  it("제목, culprit과 스택 문자열의 민감한 텍스트를 일관되게 제거한다", () => {
    const mapped = mapSentryIssue(sensitiveTextFixture);
    const evidence = JSON.stringify(mapped);

    for (const forbidden of [
      "alice@example.com",
      "bob@example.com",
      "title-secret-token-value-1234567890",
      "culprit-key-1234567890",
      "culprit-session-1234567890",
      "direct-key-1234567890",
      "frame-token-1234567890",
      "frame-password-1234567890",
      "frame-bearer-token-1234567890",
      "frame-session-1234567890",
      "frame-secret-1234567890",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturetokenvalue123",
      "Authorization",
      "Cookie",
      "\u0000",
    ]) {
      expect(evidence).not.toContain(forbidden);
    }
    expect(mapped.topStackFrames[0]?.function).not.toMatch(/[\u0000-\u001F\u007F]/);
    expect(
      mapSentryIssue({ ...sensitiveTextFixture, title: "a ".repeat(300) }).title,
    ).toHaveLength(500);
  });
});

describe("SentryClient", () => {
  it.each([
    [401, "SENTRY_AUTH_FAILED"],
    [403, "SENTRY_FORBIDDEN"],
    [404, "SENTRY_NOT_FOUND"],
    [429, "SENTRY_RATE_LIMITED"],
  ] as const)("HTTP %i를 %s로 구분한다", async (status, code) => {
    const fetch = vi.fn().mockResolvedValue(new Response("private body", { status }));
    const client = new SentryClient(fetch, {
      token: "sentry-secret",
      organizationSlug: "landit",
      projectSlug: "proofops",
    });

    await expect(client.investigateIncident("12345")).rejects.toThrow(code);
    expect(fetch).toHaveBeenCalledWith(
      "https://sentry.io/api/0/projects/landit/proofops/issues/?query=id%3A12345",
      expect.objectContaining({ headers: { Authorization: "Bearer sentry-secret" } }),
    );
  });

  it("설정된 Sentry 조직 URL이 아닌 입력을 요청하지 않는다", async () => {
    const fetch = vi.fn();
    const client = new SentryClient(fetch, {
      token: "sentry-secret",
      organizationSlug: "landit",
      projectSlug: "proofops",
    });

    await expect(client.investigateIncident("https://evil.example/issues/12345")).rejects.toThrow(
      "INPUT_INVALID",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
