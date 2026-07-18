// GitHub OAuth 프로필과 팀 allowlist의 인증 경계를 검증한다
import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  authorizeActor,
  authorizeOAuthProps,
  parseAllowedGitHubLogins,
} from "./authorization";

const allowedLogins = ["alice", "bob", "carol"];

describe("authorizeActor", () => {
  it("GitHub 사용자 정보가 없으면 미인증으로 거부한다", () => {
    expect(() => authorizeActor({}, allowedLogins)).toThrow(
      expect.objectContaining<Partial<AuthorizationError>>({ status: 401 }),
    );
  });

  it("승인 목록에 없는 GitHub login은 거부한다", () => {
    expect(() =>
      authorizeActor({ id: 404, login: "mallory" }, allowedLogins),
    ).toThrow(expect.objectContaining<Partial<AuthorizationError>>({ status: 403 }));
  });

  it("승인 목록이 비어 있으면 모든 사용자를 거부한다", () => {
    expect(() => authorizeActor({ id: 1, login: "alice" }, [])).toThrow(
      expect.objectContaining<Partial<AuthorizationError>>({ status: 403 }),
    );
  });

  it.each([
    [1, "ALICE"],
    [2, "Bob"],
    [3, "carol"],
  ])("승인된 세 사용자 %s를 대소문자와 무관하게 허용한다", (id, login) => {
    expect(authorizeActor({ id, login }, allowedLogins)).toEqual({
      githubUserId: id,
      githubLogin: login.toLowerCase(),
    });
  });

  it("allowlist와 프로필 login을 같은 방식으로 정규화한다", () => {
    expect(authorizeActor({ id: 1, login: " Alice " }, [" ALIce "])).toEqual({
      githubUserId: 1,
      githubLogin: "alice",
    });
  });
});

describe("parseAllowedGitHubLogins", () => {
  it("쉼표 목록을 중복 없는 소문자 login으로 변환한다", () => {
    expect(parseAllowedGitHubLogins(" Alice,BOB,alice, carol ")).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  it("빈 환경값은 빈 allowlist로 유지한다", () => {
    expect(parseAllowedGitHubLogins("   ")).toEqual([]);
  });
});

describe("authorizeOAuthProps", () => {
  it("OAuth Provider props에서 actor를 복원한다", () => {
    expect(
      authorizeOAuthProps(
        { githubUserId: 1, githubLogin: "Alice" },
        "alice,bob,carol",
      ),
    ).toEqual({ githubUserId: 1, githubLogin: "alice" });
  });

  it("현재 allowlist에서 제거된 기존 token actor를 거부한다", () => {
    expect(() =>
      authorizeOAuthProps(
        { githubUserId: 1, githubLogin: "alice" },
        "bob,carol",
      ),
    ).toThrow(expect.objectContaining<Partial<AuthorizationError>>({ status: 403 }));
  });
});
