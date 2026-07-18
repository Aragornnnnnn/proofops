// 외부 증거를 Notion 기술 상태로 투영하는 규칙을 검증한다
import { describe, expect, it } from "vitest";
import { deriveTechnicalStatus } from "./task-status";
import type { TaskSnapshot, TechnicalStatus } from "./types";

const cases: Array<[string, TaskSnapshot, TechnicalStatus]> = [
  ["작업 시작", { started: true, pullRequests: [], deployment: "none", requiredVerification: "pending" }, "In Progress"],
  ["PR 열림", { started: true, pullRequests: [{ state: "open", review: "pending", ci: "pending" }], deployment: "none", requiredVerification: "pending" }, "In Review"],
  ["수정 요청", { started: true, pullRequests: [{ state: "open", review: "changes_requested", ci: "passed" }], deployment: "none", requiredVerification: "pending" }, "Changes Requested"],
  ["CI 실패", { started: true, pullRequests: [{ state: "open", review: "approved", ci: "failed" }], deployment: "none", requiredVerification: "pending" }, "Blocked"],
  ["배포 중", { started: true, pullRequests: [{ state: "merged", review: "approved", ci: "passed" }], deployment: "running", requiredVerification: "pending" }, "Deploying"],
  ["검증 대기", { started: true, pullRequests: [{ state: "merged", review: "approved", ci: "passed" }], deployment: "succeeded", requiredVerification: "pending" }, "Verifying"],
  ["완료", { started: true, pullRequests: [{ state: "merged", review: "approved", ci: "passed" }], deployment: "succeeded", requiredVerification: "passed" }, "Done"],
  ["관측 불가", { started: true, pullRequests: [{ state: "merged", review: "approved", ci: "passed" }], deployment: "succeeded", requiredVerification: "unobservable" }, "Failed"],
  ["다중 PR 중 CI 실패", { started: true, pullRequests: [{ state: "merged", review: "approved", ci: "passed" }, { state: "open", review: "approved", ci: "failed" }], deployment: "succeeded", requiredVerification: "passed" }, "Blocked"],
  ["다중 PR 중 수정 요청", { started: true, pullRequests: [{ state: "merged", review: "approved", ci: "passed" }, { state: "open", review: "changes_requested", ci: "passed" }], deployment: "succeeded", requiredVerification: "passed" }, "Changes Requested"],
  ["필수 검증 실패 우선", { started: true, pullRequests: [{ state: "open", review: "approved", ci: "passed" }], deployment: "succeeded", requiredVerification: "failed" }, "Failed"],
];

describe("deriveTechnicalStatus", () => {
  it.each(cases)("%s", (_name, snapshot, expected) => {
    expect(deriveTechnicalStatus(snapshot)).toBe(expected);
  });
});
