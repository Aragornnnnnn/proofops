// 유효한 GitHub Webhook을 멱등하게 반영하고 작업 기술 상태를 재계산한다
import { deriveTechnicalStatus } from "../domain/task-status";
import type { NotionPort } from "../notion/service";
import type { TaskContext } from "../tasks/repository";
import {
  D1TaskRepository,
  recordWebhookDelivery,
  upsertPullRequest,
} from "../tasks/repository";
import type { GitHubPort, LinkedPullRequestSnapshot } from "./app-client";
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
  const pullRequestUrl = extractPullRequestUrl(event, payload);
  if (!pullRequestUrl) return jsonResponse(202, "ignored");

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
    const pullRequest = await dependencies.github.getPullRequest(pullRequestUrl);
    const linked = await findLinkedPullRequest(
      dependencies.db,
      pullRequest.repository,
      pullRequest.number,
    );
    if (!linked) return jsonResponse(202, "ignored");

    if (hasPullRequestChanged(linked, pullRequest)) {
      await persistPullRequest(dependencies, linked.taskId, linked.id, pullRequest);
      await reconcileTask(dependencies, linked.taskId);
    }
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

async function reconcileTask(
  dependencies: LinkPullRequestDependencies,
  taskId: string,
): Promise<void> {
  const snapshot = await dependencies.github.getTaskSnapshot(taskId);
  const technicalStatus = deriveTechnicalStatus(snapshot);
  const task = await dependencies.db
    .prepare("SELECT notion_page_id, technical_status FROM tasks WHERE id = ?")
    .bind(taskId)
    .first<{ notion_page_id: string; technical_status: string }>();
  if (!task || task.technical_status === technicalStatus) return;

  const now = dependencies.now ?? (() => new Date().toISOString());
  await dependencies.db
    .prepare("UPDATE tasks SET technical_status = ?, updated_at = ? WHERE id = ?")
    .bind(technicalStatus, now(), taskId)
    .run();
  try {
    await dependencies.notion.updateTechnicalStatus(task.notion_page_id, technicalStatus);
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
