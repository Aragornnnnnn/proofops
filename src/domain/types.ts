// ProofOps 작업의 외부 증거와 기술 상태 타입을 정의한다
import type { VerificationResult } from "./verification-result";

export type TechnicalStatus =
  | "In Progress"
  | "In Review"
  | "Changes Requested"
  | "Blocked"
  | "Deploying"
  | "Verifying"
  | "Done"
  | "Failed";

export interface PullRequestSnapshot {
  repository?: string;
  state: "open" | "merged" | "closed";
  review: "pending" | "approved" | "changes_requested";
  ci: "pending" | "passed" | "failed";
}

export interface TaskSnapshot {
  started: boolean;
  expectedRepositories: string[];
  pullRequests: PullRequestSnapshot[];
  deployment: "none" | "running" | "succeeded" | "failed";
  requiredVerification: VerificationResult;
}
