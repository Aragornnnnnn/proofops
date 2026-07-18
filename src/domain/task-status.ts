// 외부 시스템의 현재 증거로 Notion 기술 상태를 계산한다
import type { TaskSnapshot, TechnicalStatus } from "./types";

export function deriveTechnicalStatus(snapshot: TaskSnapshot): TechnicalStatus {
  if (
    snapshot.requiredVerification === "failed" ||
    snapshot.requiredVerification === "unobservable" ||
    snapshot.deployment === "failed"
  ) {
    return "Failed";
  }
  if (snapshot.pullRequests.some((pullRequest) => pullRequest.ci === "failed")) {
    return "Blocked";
  }
  if (
    snapshot.pullRequests.some(
      (pullRequest) => pullRequest.review === "changes_requested",
    )
  ) {
    return "Changes Requested";
  }
  if (
    snapshot.pullRequests.length > 0 &&
    snapshot.pullRequests.every((pullRequest) => pullRequest.state === "merged")
  ) {
    if (snapshot.deployment === "running") return "Deploying";
    if (
      snapshot.deployment === "succeeded" &&
      snapshot.requiredVerification === "passed"
    ) {
      return "Done";
    }
    if (snapshot.deployment === "succeeded") return "Verifying";
  }
  if (snapshot.pullRequests.some((pullRequest) => pullRequest.state === "open")) {
    return "In Review";
  }
  return "In Progress";
}
