// ProofOps 작업 서비스를 MCP 도구 호출로 안전하게 연결한다
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import adapter from "../../landit/adapter.json";
import type { Actor } from "../auth/authorization";
import type { Env } from "../env";
import { createGitHubClient, type GitHubPort } from "../github/app-client";
import { linkPullRequest, reconcileTask } from "../github/webhook";
import { createNotionClient } from "../notion/client";
import type { CreateIssueInput, NotionIssue, NotionPort } from "../notion/service";
import { createSentryClient, type SentryPort } from "../sentry/client";
import type { IncidentEvidence } from "../sentry/mapper";
import type { TaskContext } from "../tasks/repository";
import { D1TaskRepository } from "../tasks/repository";
import { TaskService } from "../tasks/service";
import {
  getTaskStatusInputSchema,
  createNotionIssueInputSchema,
  incidentEvidenceSchema,
  investigateIncidentInputSchema,
  notionIssueSchema,
  progressNoteSchema,
  recordProgressInputSchema,
  requestVerificationInputSchema,
  startTaskInputSchema,
  taskContextSchema,
  verificationDispatchSchema,
} from "./schemas";

export interface ProgressNote {
  id: string;
  taskId: string;
  kind: "test" | "blocker" | "decision";
  summary: string;
  evidenceUrl: string | null;
  createdAt: string;
}

export interface ProofOpsTools {
  startTask(input: { notionPageIdOrUrl: string }): Promise<TaskContext>;
  linkPullRequest(input: {
    taskId: string;
    pullRequestUrl: string;
  }): Promise<TaskContext>;
  getTaskStatus(input: { taskId: string }): Promise<TaskContext>;
  recordProgress(input: {
    taskId: string;
    kind: ProgressNote["kind"];
    summary: string;
    evidenceUrl?: string;
  }): Promise<ProgressNote>;
  requestVerification(input: {
    taskId: string;
    repository: string;
    environment: "develop" | "prod";
    commitSha: string;
  }): Promise<{ requestId: string; workflowRunUrl: string }>;
  investigateIncident(input: {
    sentryIssueUrlOrId: string;
  }): Promise<IncidentEvidence>;
  createNotionIssue(input: CreateIssueInput): Promise<NotionIssue>;
}

export function createProofOpsTools(
  env: Env,
  actor: Actor,
  dependencies?: {
    github?: GitHubPort;
    notion?: NotionPort;
    sentry?: SentryPort;
  },
): ProofOpsTools {
  const tasks = new D1TaskRepository(env.DB);
  const notion = dependencies?.notion ?? createNotionClient(env);
  const github = dependencies?.github ?? createGitHubClient(env);
  const sentry = dependencies?.sentry ?? createSentryClient(env);
  const taskService = new TaskService(tasks, notion, (taskId) =>
    reconcileTask({ db: env.DB, github, notion }, taskId),
  );

  return {
    async startTask({ notionPageIdOrUrl }) {
      const operation = await beginOperation(
        env.DB,
        actor,
        "start_task",
        "task",
        notionPageIdOrUrl,
        { notionPageIdOrUrl },
      );
      if (!operation.execute) {
        if (operation.record.status === "succeeded") {
          return tasks.getContext(operation.record.resourceId);
        }
        throw new Error("OPERATION_PENDING");
      }

      let issue: NotionIssue;
      try {
        issue = await notion.getIssue(notionPageIdOrUrl);
      } catch (error) {
        await markRetryable(env.DB, operation.record.eventId, error);
        throw error;
      }
      let task: TaskContext;
      try {
        task = await taskService.startTaskFromIssue(issue);
      } catch (error) {
        await markUncertain(env.DB, operation.record.eventId, error);
        throw error;
      }
      await markSucceeded(env.DB, operation.record.eventId, task.id);
      return task;
    },
    async linkPullRequest(input) {
      const operation = await beginOperation(
        env.DB,
        actor,
        "link_pull_request",
        "task",
        input.taskId,
        input,
      );
      if (!operation.execute) {
        if (operation.record.status === "succeeded") {
          return tasks.getContext(operation.record.resourceId);
        }
        throw new Error("OPERATION_PENDING");
      }
      let task: TaskContext;
      try {
        task = await linkPullRequest(input, { db: env.DB, github, notion });
      } catch (error) {
        await markUncertain(env.DB, operation.record.eventId, error);
        throw error;
      }
      await markSucceeded(env.DB, operation.record.eventId, task.id);
      return task;
    },
    getTaskStatus: ({ taskId }) => taskService.getTaskStatus(taskId),
    async recordProgress({ taskId, kind, summary, evidenceUrl }) {
      await tasks.getContext(taskId);

      const note: ProgressNote = {
        id: crypto.randomUUID(),
        taskId,
        kind,
        summary,
        evidenceUrl: evidenceUrl ?? null,
        createdAt: new Date().toISOString(),
      };
      const eventId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO progress_notes (
             id, task_id, kind, summary, evidence_url, actor_github_user_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          note.id,
          note.taskId,
          note.kind,
          note.summary,
          note.evidenceUrl,
          actor.githubUserId,
          note.createdAt,
        ),
        env.DB
          .prepare(
            `INSERT INTO audit_events (
               event_id, actor_github_user_id, action, resource_type, resource_id,
               created_at, status, idempotency_key, updated_at, error_code
             ) VALUES (?, ?, 'record_progress', 'progress_note', ?, ?, 'succeeded', NULL, ?, NULL)`,
          )
          .bind(eventId, actor.githubUserId, note.id, note.createdAt, note.createdAt),
      ]);
      return note;
    },
    async requestVerification(input) {
      await tasks.getContext(input.taskId);
      const operation = await beginOperation(
        env.DB,
        actor,
        "request_verification",
        "verification_request",
        crypto.randomUUID(),
        input,
      );
      if (!operation.execute) {
        if (operation.record.status === "succeeded") {
          const existing = await env.DB
            .prepare("SELECT request_id FROM verification_requests WHERE request_id = ?")
            .bind(operation.record.resourceId)
            .first<{ request_id: string }>();
          if (existing) {
            return {
              requestId: existing.request_id,
              workflowRunUrl: verificationWorkflowUrl(input.repository),
            };
          }
        }
        throw new Error("OPERATION_PENDING");
      }
      let verification: { requestId: string; workflowRunUrl: string };
      try {
        verification = await requestVerification(input, {
          db: env.DB,
          github,
          newId: () => operation.record.resourceId,
        });
      } catch (error) {
        await markUncertain(env.DB, operation.record.eventId, error);
        throw error;
      }
      await markSucceeded(
        env.DB,
        operation.record.eventId,
        verification.requestId,
      );
      return verification;
    },
    investigateIncident: ({ sentryIssueUrlOrId }) =>
      sentry.investigateIncident(sentryIssueUrlOrId),
    async createNotionIssue(input) {
      const operation = await beginOperation(
        env.DB,
        actor,
        "create_notion_issue",
        "notion_issue",
        crypto.randomUUID(),
        input,
      );
      if (!operation.execute) {
        if (operation.record.status === "succeeded") {
          return notion.getIssue(operation.record.resourceId);
        }
        throw new Error("OPERATION_PENDING");
      }
      let issue: NotionIssue;
      try {
        issue = await notion.createIssue(input);
      } catch (error) {
        await markUncertain(env.DB, operation.record.eventId, error);
        throw error;
      }
      await markSucceeded(env.DB, operation.record.eventId, issue.pageId);
      return issue;
    },
  };
}

type MutationAction =
  | "start_task"
  | "link_pull_request"
  | "record_progress"
  | "request_verification"
  | "create_notion_issue";

type MutationResourceType =
  | "task"
  | "progress_note"
  | "verification_request"
  | "notion_issue";

type OperationStatus = "pending" | "succeeded" | "failed_retryable";

interface OperationRecord {
  eventId: string;
  resourceId: string;
  status: OperationStatus;
}

async function beginOperation(
  db: D1Database,
  actor: Actor,
  action: MutationAction,
  resourceType: MutationResourceType,
  initialResourceId: string,
  input: unknown,
): Promise<{ record: OperationRecord; execute: boolean }> {
  const idempotencyKey = await operationKey(actor, action, input);
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO audit_events (
         event_id, actor_github_user_id, action, resource_type, resource_id,
         created_at, status, idempotency_key, updated_at, error_code
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
       RETURNING event_id, resource_id, status`,
    )
    .bind(
      eventId,
      actor.githubUserId,
      action,
      resourceType,
      initialResourceId,
      now,
      idempotencyKey,
      now,
    )
    .first<OperationRow>();
  if (inserted) return { record: mapOperation(inserted), execute: true };

  const retry = await db
    .prepare(
      `UPDATE audit_events
       SET status = 'pending', error_code = NULL, updated_at = ?
       WHERE idempotency_key = ? AND status = 'failed_retryable'
       RETURNING event_id, resource_id, status`,
    )
    .bind(now, idempotencyKey)
    .first<OperationRow>();
  if (retry) return { record: mapOperation(retry), execute: true };

  const existing = await db
    .prepare(
      `SELECT event_id, resource_id, status
       FROM audit_events WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey)
    .first<OperationRow>();
  if (!existing) throw new Error("OPERATION_STATE_MISSING");
  return { record: mapOperation(existing), execute: false };
}

interface OperationRow {
  event_id: string;
  resource_id: string;
  status: OperationStatus;
}

function mapOperation(row: OperationRow): OperationRecord {
  return {
    eventId: row.event_id,
    resourceId: row.resource_id,
    status: row.status,
  };
}

async function markSucceeded(
  db: D1Database,
  eventId: string,
  resourceId: string,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE audit_events
       SET status = 'succeeded', resource_id = ?, error_code = NULL, updated_at = ?
       WHERE event_id = ? AND status = 'pending'`,
    )
    .bind(resourceId, new Date().toISOString(), eventId)
    .run();
  if (result.meta.changes !== 1) throw new Error("OPERATION_STATE_INVALID");
}

async function markRetryable(
  db: D1Database,
  eventId: string,
  error: unknown,
): Promise<void> {
  await updateFailure(db, eventId, "failed_retryable", error);
}

async function markUncertain(
  db: D1Database,
  eventId: string,
  error: unknown,
): Promise<void> {
  try {
    await updateFailure(db, eventId, "pending", error);
  } catch {
    // 외부 효과가 불확실하므로 감사 상태 갱신 실패 시에도 pending을 유지한다.
  }
}

async function updateFailure(
  db: D1Database,
  eventId: string,
  status: "pending" | "failed_retryable",
  error: unknown,
): Promise<void> {
  await db
    .prepare(
      `UPDATE audit_events SET status = ?, error_code = ?, updated_at = ?
       WHERE event_id = ? AND status = 'pending'`,
    )
    .bind(status, safeErrorCode(error), new Date().toISOString(), eventId)
    .run();
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(message)
    ? message
    : "EXTERNAL_EFFECT_UNCERTAIN";
}

async function operationKey(
  actor: Actor,
  action: MutationAction,
  input: unknown,
): Promise<string> {
  const value = JSON.stringify([actor.githubUserId, action, canonicalize(input)]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function verificationWorkflowUrl(repository: string): string {
  return `https://github.com/${repository}/actions/workflows/proofops-verify.yml`;
}

export async function requestVerification(
  input: {
    taskId: string;
    repository: string;
    environment: "develop" | "prod";
    commitSha: string;
  },
  dependencies: {
    db: D1Database;
    github: Pick<GitHubPort, "dispatchVerification">;
    now?: () => string;
    newId?: () => string;
  },
): Promise<{ requestId: string; workflowRunUrl: string }> {
  const linkedCommit = await dependencies.db
    .prepare(
      `SELECT 1 AS linked FROM pull_requests
       WHERE task_id = ? AND lower(repository) = lower(?)
         AND lower(head_sha) = lower(?) LIMIT 1`,
    )
    .bind(input.taskId, input.repository, input.commitSha)
    .first<{ linked: number }>();
  if (!linkedCommit) throw new Error("INPUT_INVALID");
  const requestId = (dependencies.newId ?? (() => crypto.randomUUID()))();
  const now = dependencies.now ?? (() => new Date().toISOString());
  await dependencies.db
    .prepare(
      `INSERT INTO verification_requests (
        request_id, task_id, repository, environment, target_commit_sha,
        trusted_ref, status, workflow_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      requestId,
      input.taskId,
      input.repository,
      input.environment,
      input.commitSha,
      adapter.verificationRef,
      "pending",
      now(),
      now(),
    )
    .run();
  let dispatch: { workflowRunUrl: string };
  try {
    dispatch = await dependencies.github.dispatchVerification({
      ...input,
      requestId,
    });
  } catch (error) {
    try {
      await dependencies.db
        .prepare(
          `UPDATE verification_requests
           SET status = 'dispatch_failed', updated_at = ?
           WHERE request_id = ? AND status = 'pending'`,
        )
        .bind(now(), requestId)
        .run();
    } catch {
      // 요청은 pending으로 남아 늦게 도착한 Webhook과 계속 상관관계가 유지된다.
    }
    throw error;
  }
  try {
    await dependencies.db
      .prepare(
        `UPDATE verification_requests
         SET status = 'dispatched', updated_at = ?
         WHERE request_id = ? AND status = 'pending'`,
      )
      .bind(now(), requestId)
      .run();
  } catch {
    // GitHub dispatch는 성공했으므로 pending을 실패 상태로 오분류하지 않는다.
  }
  return { requestId, ...dispatch };
}

export function registerProofOpsTools(server: McpServer, tools: ProofOpsTools): void {
  server.registerTool(
    "start_task",
    {
      description: "Notion 이슈를 ProofOps 작업으로 시작한다.",
      inputSchema: mcpStartTaskInputSchema,
      outputSchema: taskContextSchema,
    },
    async (input) => {
      const parsed = startTaskInputSchema.safeParse(input);
      return parsed.success
        ? toToolResult(() => tools.startTask(parsed.data))
        : inputInvalidResult();
    },
  );
  server.registerTool(
    "link_pull_request",
    {
      description: "허용된 GitHub Pull Request를 ProofOps 작업에 연결한다.",
      inputSchema: mcpLinkPullRequestInputSchema,
      outputSchema: taskContextSchema,
    },
    async (input) => {
      const parsed = linkPullRequestInputSchema.safeParse(input);
      return parsed.success
        ? toToolResult(() => tools.linkPullRequest(parsed.data))
        : inputInvalidResult();
    },
  );
  server.registerTool(
    "get_task_status",
    {
      description: "ProofOps 작업의 현재 컨텍스트를 조회한다.",
      inputSchema: mcpGetTaskStatusInputSchema,
      outputSchema: taskContextSchema,
    },
    async (input) => {
      const parsed = getTaskStatusInputSchema.safeParse(input);
      return parsed.success
        ? toToolResult(() => tools.getTaskStatus(parsed.data))
        : inputInvalidResult();
    },
  );
  server.registerTool(
    "record_progress",
    {
      description: "작업의 테스트, 차단 또는 의사결정 진행 기록을 저장한다.",
      inputSchema: mcpRecordProgressInputSchema,
      outputSchema: progressNoteSchema,
    },
    async (input) => {
      const parsed = recordProgressInputSchema.safeParse(input);
      return parsed.success
        ? toToolResult(() => tools.recordProgress(parsed.data))
        : inputInvalidResult();
    },
  );
  server.registerTool(
    "request_verification",
    {
      description:
        "연결된 commit에 대해 허용된 GitHub Actions 읽기 전용 검증을 요청한다.",
      inputSchema: mcpRequestVerificationInputSchema,
      outputSchema: verificationDispatchSchema,
    },
    async (input) => {
      const parsed = requestVerificationInputSchema.safeParse(input);
      return parsed.success
        ? toToolResult(() => tools.requestVerification(parsed.data))
        : inputInvalidResult();
    },
  );
  server.registerTool(
    "investigate_incident",
    {
      description:
        "지정한 Sentry 이슈의 최소 근거를 읽기 전용으로 조회한다. 이 도구는 Notion 이슈를 만들지 않는다.",
      inputSchema: mcpInvestigateIncidentInputSchema,
      outputSchema: incidentEvidenceSchema,
    },
    async (input) => {
      const parsed = investigateIncidentInputSchema.safeParse(input);
      return parsed.success
        ? toToolResult(() => tools.investigateIncident(parsed.data))
        : inputInvalidResult();
    },
  );
  server.registerTool(
    "create_notion_issue",
    {
      description: "명시된 입력으로만 Notion 이슈를 생성한다.",
      inputSchema: mcpCreateNotionIssueInputSchema,
      outputSchema: notionIssueSchema,
    },
    async (input) => {
      const parsed = createNotionIssueInputSchema.safeParse(input);
      return parsed.success
        ? toToolResult(() => tools.createNotionIssue(parsed.data))
        : inputInvalidResult();
    },
  );
}

const mcpStartTaskInputSchema = z.object({
  notionPageIdOrUrl: z.string().catch(""),
});

const mcpGetTaskStatusInputSchema = z.object({
  taskId: z.string().catch(""),
});

const linkPullRequestInputSchema = z.object({
  taskId: z.string().trim().min(1),
  pullRequestUrl: z.url().refine((value) => value.startsWith("https://github.com/")),
});

const mcpLinkPullRequestInputSchema = z.object({
  taskId: z.string().catch(""),
  pullRequestUrl: z.string().catch(""),
});

const mcpRecordProgressInputSchema = z.object({
  taskId: z.string().catch(""),
  kind: z.string().catch(""),
  summary: z.string().catch(""),
  evidenceUrl: z.string().optional().catch(""),
});

const mcpRequestVerificationInputSchema = z.object({
  taskId: z.string().catch(""),
  repository: z.string().catch(""),
  environment: z.string().catch(""),
  commitSha: z.string().catch(""),
});

const mcpInvestigateIncidentInputSchema = z.object({
  sentryIssueUrlOrId: z.string().catch(""),
});

const mcpCreateNotionIssueInputSchema = z.object({
  title: z.string().catch(""),
  impact: z.string().catch(""),
  evidence: z
    .array(z.object({ label: z.string().catch(""), url: z.string().catch("") }))
    .catch([]),
  causeOrHypothesis: z.string().catch(""),
  scope: z.array(z.string().catch("")).catch([]),
  acceptanceCriteria: z.array(z.string().catch("")).catch([]),
});

async function toToolResult<T>(action: () => Promise<T>): Promise<CallToolResult> {
  try {
    const structuredContent = await action();
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent: structuredContent as Record<string, unknown>,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: toSafeMcpErrorCode(error) }],
      isError: true,
    };
  }
}

function inputInvalidResult(): CallToolResult {
  return {
    content: [{ type: "text", text: "INPUT_INVALID" }],
    isError: true,
  };
}

function toSafeMcpErrorCode(error: unknown):
  | "NOTION_READ_FAILED"
  | "GITHUB_READ_FAILED"
  | "GITHUB_REPOSITORY_NOT_ALLOWED"
  | "TASK_NOT_FOUND"
  | "INPUT_INVALID"
  | "NOTION_CREATE_FAILED"
  | "SENTRY_AUTH_FAILED"
  | "SENTRY_FORBIDDEN"
  | "SENTRY_NOT_FOUND"
  | "SENTRY_RATE_LIMITED"
  | "SENTRY_READ_FAILED" {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? error.message
      : undefined;
  if (message === "NOTION_READ_FAILED") return "NOTION_READ_FAILED";
  if (message === "GITHUB_READ_FAILED") return "GITHUB_READ_FAILED";
  if (message === "GITHUB_API_FAILED") return "GITHUB_READ_FAILED";
  if (message === "GITHUB_REPOSITORY_NOT_ALLOWED") {
    return "GITHUB_REPOSITORY_NOT_ALLOWED";
  }
  if (message === "TASK_NOT_FOUND") return "TASK_NOT_FOUND";
  if (message === "NOTION_CREATE_FAILED") return "NOTION_CREATE_FAILED";
  if (message === "SENTRY_AUTH_FAILED") return "SENTRY_AUTH_FAILED";
  if (message === "SENTRY_FORBIDDEN") return "SENTRY_FORBIDDEN";
  if (message === "SENTRY_NOT_FOUND") return "SENTRY_NOT_FOUND";
  if (message === "SENTRY_RATE_LIMITED") return "SENTRY_RATE_LIMITED";
  if (message === "SENTRY_READ_FAILED") return "SENTRY_READ_FAILED";
  return "INPUT_INVALID";
}
