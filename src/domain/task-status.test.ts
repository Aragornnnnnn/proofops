// 외부 증거를 Notion 기술 상태로 투영하는 규칙을 검증한다
import { describe, expect, it } from "vitest";
import { deriveTechnicalStatus } from "./task-status";
import type { TaskSnapshot, TechnicalStatus } from "./types";

const cases: Array<[string, TaskSnapshot, TechnicalStatus]> = [
  ["작업 시작", { started: true, expectedRepositories: [], pullRequests: [], deployment: "none", requiredVerification: "pending" }, "In Progress"],
  ["PR 열림", { started: true, expectedRepositories: [], pullRequests: [{ state: "open", review: "pending", ci: "pending" }], deployment: "none", requiredVerification: "pending" }, "In Review"],
  ["수정 요청", { started: true, expectedRepositories: [], pullRequests: [{ state: "open", review: "changes_requested", ci: "passed" }], deployment: "none", requiredVerification: "pending" }, "Changes Requested"],
  ["CI 실패", { started: true, expectedRepositories: [], pullRequests: [{ state: "open", review: "approved", ci: "failed" }], deployment: "none", requiredVerification: "pending" }, "Blocked"],
  ["배포 중", { started: true, expectedRepositories: [], pullRequests: [{ state: "merged", review: "approved", ci: "passed" }], deployment: "running", requiredVerification: "pending" }, "Deploying"],
  ["검증 대기", { started: true, expectedRepositories: [], pullRequests: [{ state: "merged", review: "approved", ci: "passed" }], deployment: "succeeded", requiredVerification: "pending" }, "Verifying"],
  ["완료", { started: true, expectedRepositories: [], pullRequests: [{ state: "merged", review: "approved", ci: "passed" }], deployment: "succeeded", requiredVerification: "passed" }, "Done"],
  ["관측 불가", { started: true, expectedRepositories: [], pullRequests: [{ state: "merged", review: "approved", ci: "passed" }], deployment: "succeeded", requiredVerification: "unobservable" }, "Failed"],
  ["다중 PR 중 CI 실패", { started: true, expectedRepositories: [], pullRequests: [{ state: "merged", review: "approved", ci: "passed" }, { state: "open", review: "approved", ci: "failed" }], deployment: "succeeded", requiredVerification: "passed" }, "Blocked"],
  ["다중 PR 중 수정 요청", { started: true, expectedRepositories: [], pullRequests: [{ state: "merged", review: "approved", ci: "passed" }, { state: "open", review: "changes_requested", ci: "passed" }], deployment: "succeeded", requiredVerification: "passed" }, "Changes Requested"],
  ["필수 검증 실패 우선", { started: true, expectedRepositories: [], pullRequests: [{ state: "open", review: "approved", ci: "passed" }], deployment: "succeeded", requiredVerification: "failed" }, "Failed"],
];

describe("deriveTechnicalStatus", () => {
  it.each(cases)("%s", (_name, snapshot, expected) => {
    expect(deriveTechnicalStatus(snapshot)).toBe(expected);
  });

  it("필수 저장소 PR 하나가 누락되면 나머지가 완료돼도 Done이 아니다", () => {
    expect(
      deriveTechnicalStatus({
        started: true,
        expectedRepositories: ["landit-be", "landit-ai"],
        pullRequests: [
          {
            repository: "Aragornnnnnn/landit-be",
            state: "merged",
            review: "approved",
            ci: "passed",
          },
        ],
        deployment: "succeeded",
        requiredVerification: "passed",
      }),
    ).not.toBe("Done");
  });

  it.each([
    ["pending", "Verifying"],
    ["unobservable", "Failed"],
  ] as const)("모든 필수 PR이 머지됐지만 검증이 %s이면 %s이다", (verification, expected) => {
    expect(
      deriveTechnicalStatus({
        started: true,
        expectedRepositories: ["landit-be", "landit-ai"],
        pullRequests: [
          {
            repository: "Aragornnnnnn/landit-be",
            state: "merged",
            review: "approved",
            ci: "passed",
          },
          {
            repository: "Aragornnnnnn/landit-ai",
            state: "merged",
            review: "approved",
            ci: "passed",
          },
        ],
        deployment: "succeeded",
        requiredVerification: verification,
      }),
    ).toBe(expected);
  });
});
