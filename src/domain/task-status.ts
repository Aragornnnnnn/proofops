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
  if (hasMergedPullRequestForEveryExpectedRepository(snapshot)) {
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

function hasMergedPullRequestForEveryExpectedRepository(
  snapshot: TaskSnapshot,
): boolean {
  if (snapshot.pullRequests.length === 0) return false;
  const expectedRepositories = snapshot.expectedRepositories;
  if (expectedRepositories.length === 0) {
    return snapshot.pullRequests.every((pullRequest) => pullRequest.state === "merged");
  }

  const mergedRepositories = new Set(
    snapshot.pullRequests
      .filter((pullRequest) => pullRequest.state === "merged")
      .flatMap((pullRequest) =>
        pullRequest.repository ? [repositoryName(pullRequest.repository)] : [],
      ),
  );
  return expectedRepositories.every((repository) =>
    mergedRepositories.has(repositoryName(repository)),
  );
}

function repositoryName(repository: string): string {
  return repository.trim().toLowerCase().split("/").at(-1) ?? "";
}
