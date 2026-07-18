// 유효한 GitHub Webhook을 멱등하게 반영하고 작업 기술 상태를 재계산한다
import adapter from "../../landit/adapter.json";
import { deriveTechnicalStatus } from "../domain/task-status";
import { mapTechnicalStatusForNotion } from "../tasks/service";
import type { NotionPort } from "../notion/service";
import type { TaskContext } from "../tasks/repository";
import {
  D1TaskRepository,
  recordWebhookDelivery,
  upsertPullRequest,
} from "../tasks/repository";
import type { GitHubPort, LinkedPullRequestSnapshot } from "./app-client";
import {
  deriveVerificationStatus,
  parseVerificationArtifact,
} from "./verification-artifact";
import {
  assertAllowedPullRequest,
  extractPullRequestUrl,
  supportedGitHubEvents,
} from "./events";

export interface GitHubWebhookDependencies {
  db: D1Database;
  webhookSecret: string;
  github: GitHubPort;
  notion: NotionPort;
  now?: () => string;
  newId?: () => string;
}

export interface LinkPullRequestDependencies {
  db: D1Database;
  github: GitHubPort;
  notion: NotionPort;
  now?: () => string;
  newId?: () => string;
}

export async function handleGitHubWebhook(
  request: Request,
  dependencies: GitHubWebhookDependencies,
): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!(await verifyWebhookSignature(body, signature, dependencies.webhookSecret))) {
    return jsonResponse(401, "invalid_signature");
  }

  const event = request.headers.get("x-github-event") ?? "";
  if (!supportedGitHubEvents.has(event)) return jsonResponse(202, "ignored");

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return jsonResponse(400, "invalid_payload");
  }
  const verificationRun = extractVerificationRun(event, payload);
  const pullRequestUrl = verificationRun
    ? null
    : extractPullRequestUrl(event, payload);
  if (!verificationRun && !pullRequestUrl) return jsonResponse(202, "ignored");

  const deliveryId = request.headers.get("x-github-delivery");
  if (!deliveryId) return jsonResponse(400, "invalid_delivery");
  const now = dependencies.now ?? (() => new Date().toISOString());
  const recorded = await recordWebhookDelivery(dependencies.db, {
    provider: "github",
    deliveryId,
    receivedAt: now(),
  });
  if (!recorded) return jsonResponse(202, "duplicate");

  try {
    if (verificationRun) {
      const processed = await processVerificationRun(dependencies, verificationRun);
      return jsonResponse(202, processed ? "processed" : "ignored");
    }
    if (!pullRequestUrl) return jsonResponse(202, "ignored");
    const pullRequest = await dependencies.github.getPullRequest(pullRequestUrl);
    const linked = await findLinkedPullRequest(
      dependencies.db,
      pullRequest.repository,
      pullRequest.number,
    );
    if (!linked) return jsonResponse(202, "ignored");

    if (hasPullRequestChanged(linked, pullRequest)) {
      await persistPullRequest(dependencies, linked.taskId, linked.id, pullRequest);
    }
    await reconcileTask(dependencies, linked.taskId);
    return jsonResponse(202, "processed");
  } catch {
    await dependencies.db
      .prepare(
        "DELETE FROM webhook_deliveries WHERE provider = 'github' AND delivery_id = ?",
      )
      .bind(deliveryId)
      .run();
    return jsonResponse(502, "retry");
  }
}

interface VerificationWorkflowRun {
  id: number;
  requestId: string;
  repository: string;
  headBranch: string;
  evidenceUrl: string;
}

function extractVerificationRun(
  event: string,
  payload: unknown,
): VerificationWorkflowRun | null {
  if (event !== "workflow_run" || !isObject(payload)) return null;
  const workflowRun = isObject(payload.workflow_run) ? payload.workflow_run : null;
  const repository = isObject(payload.repository)
    ? payload.repository.full_name
    : null;
  const path = typeof workflowRun?.path === "string"
    ? workflowRun.path.split("@")[0]
    : null;
  const id = workflowRun?.id;
  const workflowSha = workflowRun?.head_sha;
  const headBranch = workflowRun?.head_branch;
  const displayTitle = workflowRun?.display_title;
  const requestId = typeof displayTitle === "string"
    ? /^ProofOps verification ([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
        displayTitle,
      )?.[1]
    : undefined;
  const allowed =
    typeof repository === "string" &&
    adapter.allowedRepositories.some(
      (candidate) => candidate.toLowerCase() === repository.toLowerCase(),
    );
  if (
    payload.action !== "completed" ||
    workflowRun?.event !== "workflow_dispatch" ||
    path !== `.github/workflows/${adapter.verificationWorkflow}` ||
    !allowed ||
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof workflowSha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(workflowSha) ||
    typeof headBranch !== "string" ||
    !requestId
  ) {
    return null;
  }
  return {
    id,
    requestId,
    repository,
    headBranch,
    evidenceUrl: `https://github.com/${repository}/actions/runs/${id}`,
  };
}

async function processVerificationRun(
  dependencies: GitHubWebhookDependencies,
  run: VerificationWorkflowRun,
): Promise<boolean> {
  const verificationRequest = await dependencies.db
    .prepare(
      `SELECT request_id, task_id, repository, environment, target_commit_sha,
              trusted_ref, status
       FROM verification_requests WHERE request_id = ?`,
    )
    .bind(run.requestId)
    .first<{
      request_id: string;
      task_id: string;
      repository: string;
      environment: "develop" | "prod";
      target_commit_sha: string;
      trusted_ref: string;
      status: string;
    }>();
  if (
    !verificationRequest ||
    verificationRequest.repository.toLowerCase() !== run.repository.toLowerCase() ||
    verificationRequest.trusted_ref !== run.headBranch ||
    (verificationRequest.status !== "pending" &&
      verificationRequest.status !== "dispatched")
  ) {
    return false;
  }

  let rawArtifact: unknown;
  try {
    rawArtifact = await dependencies.github.getVerificationArtifact({
      repository: run.repository,
      workflowRunId: run.id,
      requestId: run.requestId,
    });
  } catch (error) {
    if (!isInvalidArtifactError(error)) throw error;
    await recordVerificationRun(dependencies, run, verificationRequest, {
      environment: "unknown",
      status: "failed",
      resultJson: JSON.stringify({ error: "VERIFICATION_ARTIFACT_INVALID" }),
    });
    await reconcileTask(dependencies, verificationRequest.task_id);
    return true;
  }
  let artifact;
  try {
    artifact = parseVerificationArtifact(rawArtifact, {
      taskId: verificationRequest.task_id,
      requestId: verificationRequest.request_id,
      repository: run.repository,
      environment: verificationRequest.environment,
      commitSha: verificationRequest.target_commit_sha,
      evidenceUrl: run.evidenceUrl,
    });
  } catch (error) {
    if (!isInvalidArtifactError(error)) throw error;
    await recordVerificationRun(dependencies, run, verificationRequest, {
      environment: "unknown",
      status: "failed",
      resultJson: JSON.stringify({ error: "VERIFICATION_ARTIFACT_INVALID" }),
    });
    await reconcileTask(dependencies, verificationRequest.task_id);
    return true;
  }
  await recordVerificationRun(dependencies, run, verificationRequest, {
    environment: artifact.environment,
    status: deriveVerificationStatus(artifact),
    resultJson: JSON.stringify(artifact),
  });
  await reconcileTask(dependencies, verificationRequest.task_id);
  return true;
}

async function recordVerificationRun(
  dependencies: GitHubWebhookDependencies,
  run: VerificationWorkflowRun,
  verificationRequest: {
    request_id: string;
    task_id: string;
    target_commit_sha: string;
  },
  result: {
    environment: "develop" | "prod" | "unknown";
    status: "passed" | "failed";
    resultJson: string;
  },
): Promise<void> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  await dependencies.db.batch([
    dependencies.db.prepare(
      `INSERT INTO verification_runs (
        id, request_id, task_id, repository, environment, commit_sha,
        workflow_run_id, status, evidence_url, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        evidence_url = excluded.evidence_url,
        result_json = excluded.result_json`,
    ).bind(
      `github-workflow-${run.id}`,
      verificationRequest.request_id,
      verificationRequest.task_id,
      run.repository,
      result.environment,
      verificationRequest.target_commit_sha,
      run.id,
      result.status,
      run.evidenceUrl,
      result.resultJson,
      now(),
    ),
    dependencies.db
      .prepare(
        `UPDATE verification_requests
         SET status = ?, workflow_run_id = ?, updated_at = ?
         WHERE request_id = ?`,
      )
      .bind(result.status, run.id, now(), verificationRequest.request_id),
  ]);
}

function isInvalidArtifactError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "VERIFICATION_ARTIFACT_INVALID" ||
    error.message === "GITHUB_VERIFICATION_ARTIFACT_INVALID"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function linkPullRequest(
  input: { taskId: string; pullRequestUrl: string },
  dependencies: LinkPullRequestDependencies,
): Promise<TaskContext> {
  assertAllowedPullRequest(input.pullRequestUrl);
  const tasks = new D1TaskRepository(dependencies.db);
  await tasks.getContext(input.taskId);

  const pullRequest = await dependencies.github.getPullRequest(input.pullRequestUrl);
  const currentReference = assertAllowedPullRequest(pullRequest.url);
  if (
    pullRequest.repository.toLowerCase() !==
    currentReference.repository.toLowerCase()
  ) {
    throw new Error("GITHUB_REPOSITORY_NOT_ALLOWED");
  }

  await persistPullRequest(
    dependencies,
    input.taskId,
    (dependencies.newId ?? (() => crypto.randomUUID()))(),
    pullRequest,
  );
  await reconcileTask(dependencies, input.taskId);
  return tasks.getContext(input.taskId);
}

export async function verifyWebhookSignature(
  body: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const digest = signature.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(digest)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    hexToBytes(digest),
    new TextEncoder().encode(body),
  );
}

async function persistPullRequest(
  dependencies: LinkPullRequestDependencies,
  taskId: string,
  id: string,
  pullRequest: LinkedPullRequestSnapshot,
): Promise<void> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  await upsertPullRequest(dependencies.db, {
    id,
    taskId,
    repository: pullRequest.repository,
    prNumber: pullRequest.number,
    prUrl: pullRequest.url,
    state: pullRequest.state,
    reviewState: pullRequest.review,
    ciState: pullRequest.ci,
    headSha: pullRequest.headSha,
    updatedAt: now(),
  });
}

export async function reconcileTask(
  dependencies: LinkPullRequestDependencies,
  taskId: string,
): Promise<void> {
  const snapshot = await dependencies.github.getTaskSnapshot(taskId);
  const technicalStatus = deriveTechnicalStatus(snapshot);
  const task = await dependencies.db
    .prepare("SELECT notion_page_id, technical_status FROM tasks WHERE id = ?")
    .bind(taskId)
    .first<{ notion_page_id: string; technical_status: string }>();
  if (!task) return;

  const now = dependencies.now ?? (() => new Date().toISOString());
  if (task.technical_status !== technicalStatus) {
    await dependencies.db
      .prepare("UPDATE tasks SET technical_status = ?, updated_at = ? WHERE id = ?")
      .bind(technicalStatus, now(), taskId)
      .run();
  }
  try {
    await dependencies.notion.updateTechnicalStatus(
      task.notion_page_id,
      mapTechnicalStatusForNotion(technicalStatus),
    );
    await dependencies.db
      .prepare("UPDATE tasks SET last_sync_error = NULL, updated_at = ? WHERE id = ?")
      .bind(now(), taskId)
      .run();
  } catch {
    await dependencies.db
      .prepare("UPDATE tasks SET last_sync_error = ?, updated_at = ? WHERE id = ?")
      .bind("NOTION_SYNC_FAILED", now(), taskId)
      .run();
  }
}

interface LinkedPullRequestRow {
  id: string;
  taskId: string;
  state: string;
  review: string;
  ci: string;
  headSha: string;
}

async function findLinkedPullRequest(
  db: D1Database,
  repository: string,
  number: number,
): Promise<LinkedPullRequestRow | null> {
  const row = await db
    .prepare(
      `SELECT id, task_id, state, review_state, ci_state, head_sha
       FROM pull_requests WHERE lower(repository) = lower(?) AND pr_number = ?`,
    )
    .bind(repository, number)
    .first<{
      id: string;
      task_id: string;
      state: string;
      review_state: string;
      ci_state: string;
      head_sha: string;
    }>();
  return row
    ? {
        id: row.id,
        taskId: row.task_id,
        state: row.state,
        review: row.review_state,
        ci: row.ci_state,
        headSha: row.head_sha,
      }
    : null;
}

function hasPullRequestChanged(
  current: LinkedPullRequestRow,
  next: LinkedPullRequestSnapshot,
): boolean {
  return (
    current.state !== next.state ||
    current.review !== next.review ||
    current.ci !== next.ci ||
    current.headSha !== next.headSha
  );
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function jsonResponse(status: number, result: string): Response {
  return Response.json({ status: result }, { status });
}
