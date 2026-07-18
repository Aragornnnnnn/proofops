// Worker의 기본 HTTP 동작을 검증하는 통합 테스트
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("서비스 상태를 반환한다", async () => {
    const response = await SELF.fetch("https://proofops.test/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "proofops",
      status: "ok",
      environment: env.ENVIRONMENT,
    });
  });
});
