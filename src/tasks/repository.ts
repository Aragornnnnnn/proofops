// D1에 작업과 외부 증거 연결 메타데이터를 저장한다
import type { TechnicalStatus } from "../domain/types";

export interface CreateTaskInput {
  id: string;
  notionPageId: string;
  notionUrl: string;
  title: string;
  technicalStatus: TechnicalStatus;
  expectedRepositories: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestInput {
  id: string;
  taskId: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  state: "open" | "merged" | "closed";
  reviewState: "pending" | "approved" | "changes_requested";
  ciState: "pending" | "passed" | "failed";
  headSha: string;
  updatedAt: string;
}

export interface WebhookDeliveryInput {
  provider: string;
  deliveryId: string;
  receivedAt: string;
}

export async function createTask(db: D1Database, input: CreateTaskInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tasks (
        id, notion_page_id, notion_url, title, technical_status,
        expected_repositories, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.notionPageId,
      input.notionUrl,
      input.title,
      input.technicalStatus,
      JSON.stringify(input.expectedRepositories),
      input.createdAt,
      input.updatedAt,
    )
    .run();
}

export async function upsertPullRequest(
  db: D1Database,
  input: PullRequestInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pull_requests (
        id, task_id, repository, pr_number, pr_url, state,
        review_state, ci_state, head_sha, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository, pr_number) DO UPDATE SET
        task_id = excluded.task_id,
        pr_url = excluded.pr_url,
        state = excluded.state,
        review_state = excluded.review_state,
        ci_state = excluded.ci_state,
        head_sha = excluded.head_sha,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.taskId,
      input.repository,
      input.prNumber,
      input.prUrl,
      input.state,
      input.reviewState,
      input.ciState,
      input.headSha,
      input.updatedAt,
    )
    .run();
}

export async function recordWebhookDelivery(
  db: D1Database,
  input: WebhookDeliveryInput,
): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO webhook_deliveries (provider, delivery_id, received_at) VALUES (?, ?, ?)",
    )
    .bind(input.provider, input.deliveryId, input.receivedAt)
    .run();

  return result.meta.changes === 1;
}
