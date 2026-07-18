// D1에 작업과 외부 증거 연결 메타데이터를 저장한다
import type { TechnicalStatus } from "../domain/types";
import type { NotionIssue } from "../notion/service";

export interface TaskRecord {
  id: string;
  notionPageId: string;
  notionUrl: string;
  title: string;
  technicalStatus: TechnicalStatus;
  expectedRepositories: string[];
  lastSyncError: string | null;
}

export interface TaskContext extends TaskRecord {
  missingRepositories: string[];
}

export interface TaskRepository {
  upsertFromNotion(issue: NotionIssue): Promise<TaskRecord>;
  clearSyncError(taskId: string): Promise<void>;
  recordSyncError(taskId: string, message: string): Promise<void>;
  getContext(taskId: string): Promise<TaskContext>;
}

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
        review_state, ci_state, head_sha, linked_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

export class D1TaskRepository implements TaskRepository {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async upsertFromNotion(issue: NotionIssue): Promise<TaskRecord> {
    const existing = await this.findByNotionPageId(issue.pageId);
    if (existing) return existing;

    const timestamp = this.now();
    const task: TaskRecord = {
      id: this.newId(),
      notionPageId: issue.pageId,
      notionUrl: issue.url,
      title: issue.title,
      technicalStatus: "In Progress",
      expectedRepositories: issue.repositories,
      lastSyncError: null,
    };
    await createTask(this.db, {
      ...task,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return task;
  }

  async clearSyncError(taskId: string): Promise<void> {
    await this.db
      .prepare("UPDATE tasks SET last_sync_error = NULL, updated_at = ? WHERE id = ?")
      .bind(this.now(), taskId)
      .run();
  }

  async recordSyncError(taskId: string, message: string): Promise<void> {
    await this.db
      .prepare("UPDATE tasks SET last_sync_error = ?, updated_at = ? WHERE id = ?")
      .bind(message, this.now(), taskId)
      .run();
  }

  async getContext(taskId: string): Promise<TaskContext> {
    const task = await this.db
      .prepare(`SELECT id, notion_page_id, notion_url, title, technical_status,
        expected_repositories, last_sync_error FROM tasks WHERE id = ?`)
      .bind(taskId)
      .first<TaskRow>();
    if (!task) throw new Error("TASK_NOT_FOUND");
    const record = toTaskRecord(task);
    const pullRequests = await this.db
      .prepare("SELECT repository FROM pull_requests WHERE task_id = ? ORDER BY updated_at DESC, pr_number DESC")
      .bind(taskId)
      .all<{ repository: string }>();
    const connectedRepositories = new Set(
      pullRequests.results.map((pullRequest) => repositoryName(pullRequest.repository)),
    );
    return {
      ...record,
      missingRepositories: record.expectedRepositories.filter(
        (repository) => !connectedRepositories.has(repositoryName(repository)),
      ),
    };
  }

  private async findByNotionPageId(pageId: string): Promise<TaskRecord | null> {
    const task = await this.db
      .prepare(`SELECT id, notion_page_id, notion_url, title, technical_status,
        expected_repositories, last_sync_error FROM tasks WHERE notion_page_id = ?`)
      .bind(pageId)
      .first<TaskRow>();
    return task ? toTaskRecord(task) : null;
  }
}

function repositoryName(repository: string): string {
  return repository.trim().toLowerCase().split("/").at(-1) ?? "";
}

interface TaskRow {
  id: string;
  notion_page_id: string;
  notion_url: string;
  title: string;
  technical_status: TechnicalStatus;
  expected_repositories: string;
  last_sync_error: string | null;
}

function toTaskRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    notionPageId: row.notion_page_id,
    notionUrl: row.notion_url,
    title: row.title,
    technicalStatus: row.technical_status,
    expectedRepositories: JSON.parse(row.expected_repositories) as string[],
    lastSyncError: row.last_sync_error,
  };
}
