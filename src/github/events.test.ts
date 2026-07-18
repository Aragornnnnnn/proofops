// ProofOps가 허용한 GitHub 저장소 경계가 유지되는지 검증한다
import { describe, expect, it } from "vitest";
import { assertAllowedPullRequest } from "./events";

describe("GitHub repository allowlist", () => {
  it("ProofOps sandbox Pull Request를 허용한다", () => {
    expect(
      assertAllowedPullRequest(
        "https://github.com/Aragornnnnnn/proofops-sandbox/pull/1",
      ),
    ).toMatchObject({
      repository: "Aragornnnnnn/proofops-sandbox",
      number: 1,
    });
  });

  it("등록되지 않은 저장소는 계속 거부한다", () => {
    expect(() =>
      assertAllowedPullRequest("https://github.com/attacker/other/pull/1"),
    ).toThrow("GITHUB_REPOSITORY_NOT_ALLOWED");
  });
});
