// 표준 런타임 검증 결과와 작업 상태 집계 계약을 정의한다
export type VerificationStatus = "pending" | "passed" | "failed" | "unobservable";

export interface VerificationResult {
  schemaVersion: 1;
  requestId: string;
  taskId: string;
  repository: string;
  environment: "develop" | "prod";
  commitSha: string;
  status: "passed" | "failed" | "unobservable";
  checks: Array<{
    name: "deployment" | "ecs" | "alb" | "api" | "sentry";
    status: "passed" | "failed" | "unobservable" | "skipped";
    evidenceUrl?: string;
    summary: string;
  }>;
  observedAt: string;
}
