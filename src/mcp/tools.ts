// ProofOps 작업 서비스를 MCP 도구 호출로 안전하게 연결한다
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import adapter from "../../landit/adapter.json";
import type { Actor } from "../auth/authorization";
import type { Env } from "../env";
import { createGitHubClient, type GitHubPort } from "../github/app-client";
import { reconcileTask } from "../github/webhook";
import { assertAllowedPullRequest } from "../github/events";
import { createNotionClient } from "../notion/client";
import type { CreateIssueInput, NotionIssue, NotionPort } from "../notion/service";
import { createSentryClient, type SentryPort } from "../sentry/client";
import type { IncidentEvidence } from "../sentry/mapper";
import type { TaskContext } from "../tasks/repository";
import { D1TaskRepository, prepareUpsertPullRequest } from "../tasks/repository";
import { mapTechnicalStatusForNotion, TaskService } from "../tasks/service";
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
  linkPullRequestInputSchema,
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
  startTask(input: { operationId: string; notionPageIdOrUrl: string }): Promise<TaskContext>;
  linkPullRequest(input: {
    operationId: string;
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
    operationId: string;
    taskId: string;
    repository: string;
    environment: "develop" | "prod";
    commitSha: string;
  }): Promise<{
    requestId: string;
    workflowRunUrl: string;
    status: string;
  }>;
  investigateIncident(input: {
    sentryIssueUrlOrId: string;
  }): Promise<IncidentEvidence>;
  createNotionIssue(input: CreateIssueInput & { operationId: string }): Promise<NotionIssue>;
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
    async startTask({ operationId, notionPageIdOrUrl }) {
      const issue = await notion.getIssue(notionPageIdOrUrl);
      const operation = await openOperation(
        env.DB,
        actor,
        operationId,
        "start_task",
        "task",
        notionPageIdOrUrl,
        { notionPageIdOrUrl },
      );
      if (operation.phase === "succeeded") {
        return tasks.getContext(operation.resourceId);
      }
      const task = await tasks.upsertFromNotion(issue);
      await setOperationPhase(env.DB, operationId, "effect_started", task.id);
      try {
        await notion.updateTechnicalStatus(
          task.notionPageId,
          mapTechnicalStatusForNotion(task.technicalStatus),
        );
        await tasks.clearSyncError(task.id);
      } catch (error) {
        await tasks.recordSyncError(task.id, "NOTION_SYNC_FAILED");
        await setOperationPhase(
          env.DB,
          operationId,
          "failed_retryable",
          task.id,
          error,
        );
        throw error;
      }
      await setOperationPhase(env.DB, operationId, "succeeded", task.id);
      return tasks.getContext(task.id);
    },
    async linkPullRequest(input) {
      const { operationId, ...linkInput } = input;
      assertAllowedPullRequest(linkInput.pullRequestUrl);
      await tasks.getContext(linkInput.taskId);
      const pullRequest = await github.getPullRequest(linkInput.pullRequestUrl);
      const currentReference = assertAllowedPullRequest(pullRequest.url);
      if (
        pullRequest.repository.toLowerCase() !==
        currentReference.repository.toLowerCase()
      ) {
        throw new Error("GITHUB_REPOSITORY_NOT_ALLOWED");
      }
      const operation = await openOperation(
        env.DB,
        actor,
        operationId,
        "link_pull_request",
        "task",
        linkInput.taskId,
        linkInput,
      );
      if (operation.phase === "succeeded") {
        return tasks.getContext(operation.resourceId);
      }
      await setOperationPhase(env.DB, operationId, "effect_started", linkInput.taskId);
      try {
        const now = new Date().toISOString();
        await env.DB.batch([
          prepareUpsertPullRequest(env.DB, {
            id: crypto.randomUUID(),
            taskId: linkInput.taskId,
            repository: pullRequest.repository,
            prNumber: pullRequest.number,
            prUrl: pullRequest.url,
            state: pullRequest.state,
            reviewState: pullRequest.review,
            ciState: pullRequest.ci,
            headSha: pullRequest.headSha,
            updatedAt: now,
          }),
          env.DB
            .prepare(
              `UPDATE audit_events
               SET status = 'succeeded', resource_id = ?, error_code = NULL,
                   updated_at = ?
               WHERE operation_id = ?`,
            )
            .bind(linkInput.taskId, now, operationId),
        ]);
      } catch (error) {
        await setOperationPhase(
          env.DB,
          operationId,
          "failed_retryable",
          linkInput.taskId,
          error,
        );
        throw error;
      }
      try {
        await reconcileTask({ db: env.DB, github, notion }, linkInput.taskId);
      } catch {
        // 링크 저장은 완료됐으므로 후속 조회에서 다시 조정한다.
      }
      return tasks.getContext(linkInput.taskId);
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
      const { operationId, ...verificationInput } = input;
      await tasks.getContext(verificationInput.taskId);
      const linkedCommit = await env.DB
        .prepare(
          `SELECT 1 AS linked FROM pull_requests
           WHERE task_id = ? AND lower(repository) = lower(?)
             AND lower(head_sha) = lower(?) LIMIT 1`,
        )
        .bind(
          verificationInput.taskId,
          verificationInput.repository,
          verificationInput.commitSha,
        )
        .first();
      if (!linkedCommit) throw new Error("INPUT_INVALID");
      const operation = await openOperation(
        env.DB,
        actor,
        operationId,
        "request_verification",
        "verification_request",
        operationId,
        verificationInput,
      );
      if (operation.phase !== "validated" && operation.phase !== "failed_retryable") {
        const existing = await verificationResult(
          env.DB,
          operationId,
          verificationInput.repository,
        );
        if (existing) return existing;
        throw new Error("OPERATION_RECONCILE_REQUIRED");
      }
      await setOperationPhase(env.DB, operationId, "effect_started", operationId);
      try {
        await requestVerification(verificationInput, {
          db: env.DB,
          github,
          newId: () => operationId,
        });
      } catch (error) {
        const existing = await verificationResult(
          env.DB,
          operationId,
          verificationInput.repository,
        );
        if (existing) {
          await setOperationPhase(env.DB, operationId, "succeeded", operationId);
          return existing;
        }
        await setOperationPhase(
          env.DB,
          operationId,
          "failed_retryable",
          operationId,
          error,
        );
        throw error;
      }
      await setOperationPhase(env.DB, operationId, "succeeded", operationId);
      const result = await verificationResult(
        env.DB,
        operationId,
        verificationInput.repository,
      );
      if (!result) throw new Error("OPERATION_STATE_MISSING");
      return result;
    },
    investigateIncident: ({ sentryIssueUrlOrId }) =>
      sentry.investigateIncident(sentryIssueUrlOrId),
    async createNotionIssue(input) {
      const { operationId, ...issueInput } = input;
      const operation = await openOperation(
        env.DB,
        actor,
        operationId,
        "create_notion_issue",
        "notion_issue",
        operationId,
        issueInput,
      );
      if (operation.phase === "succeeded") {
        return notion.getIssue(operation.resourceId);
      }
      if (
        operation.phase === "effect_started" ||
        operation.phase === "reconcile_required"
      ) {
        return reconcileNotionCreation(env.DB, notion, operationId);
      }
      await setOperationPhase(env.DB, operationId, "effect_started", operationId);
      try {
        const issue = await notion.createIssue(issueInput, operationId);
        await setOperationPhase(env.DB, operationId, "succeeded", issue.pageId);
        return issue;
      } catch (error) {
        return reconcileNotionCreation(env.DB, notion, operationId);
      }
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

type OperationPhase =
  | "validated"
  | "effect_started"
  | "succeeded"
  | "failed_retryable"
  | "reconcile_required";

interface OperationRecord {
  operationId: string;
  resourceId: string;
  phase: OperationPhase;
}

async function openOperation(
  db: D1Database,
  actor: Actor,
  operationId: string,
  action: MutationAction,
  resourceType: MutationResourceType,
  initialResourceId: string,
  input: unknown,
): Promise<OperationRecord> {
  const inputHash = await operationInputHash(input);
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO audit_events (
         event_id, actor_github_user_id, action, resource_type, resource_id,
         created_at, status, idempotency_key, updated_at, error_code,
         operation_id, input_hash
       ) VALUES (?, ?, ?, ?, ?, ?, 'validated', NULL, ?, NULL, ?, ?)`,
    )
    .bind(
      eventId,
      actor.githubUserId,
      action,
      resourceType,
      initialResourceId,
      now,
      now,
      operationId,
      inputHash,
    )
    .run();
  const existing = await db
    .prepare(
      `SELECT operation_id, actor_github_user_id, action, input_hash,
              resource_id, status
       FROM audit_events WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<OperationRow>();
  if (!existing) throw new Error("OPERATION_STATE_MISSING");
  if (
    existing.actor_github_user_id !== actor.githubUserId ||
    existing.action !== action ||
    existing.input_hash !== inputHash
  ) {
    throw new Error("OPERATION_CONFLICT");
  }
  return mapOperation(existing);
}

interface OperationRow {
  operation_id: string;
  actor_github_user_id: number;
  action: string;
  input_hash: string;
  resource_id: string;
  status: OperationPhase;
}

function mapOperation(row: OperationRow): OperationRecord {
  return {
    operationId: row.operation_id,
    resourceId: row.resource_id,
    phase: row.status,
  };
}

async function setOperationPhase(
  db: D1Database,
  operationId: string,
  phase: OperationPhase,
  resourceId: string,
  error?: unknown,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE audit_events
       SET status = ?, resource_id = ?, error_code = ?, updated_at = ?
       WHERE operation_id = ?`,
    )
    .bind(
      phase,
      resourceId,
      error === undefined ? null : safeErrorCode(error),
      new Date().toISOString(),
      operationId,
    )
    .run();
  if (result.meta.changes !== 1) throw new Error("OPERATION_STATE_INVALID");
}

async function reconcileNotionCreation(
  db: D1Database,
  notion: NotionPort,
  operationId: string,
): Promise<NotionIssue> {
  try {
    const issue = await notion.findIssueByOperationMarker?.(operationId);
    if (issue) {
      await setOperationPhase(db, operationId, "succeeded", issue.pageId);
      return issue;
    }
  } catch {
    // 조회 실패도 marker의 존재나 부재를 증명하지 못한다.
  }
  await setOperationPhase(
    db,
    operationId,
    "reconcile_required",
    operationId,
    new Error("OPERATION_RECONCILE_REQUIRED"),
  );
  throw new Error("OPERATION_RECONCILE_REQUIRED");
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(message)
    ? message
    : "EXTERNAL_EFFECT_UNCERTAIN";
}

async function operationInputHash(input: unknown): Promise<string> {
  const value = JSON.stringify(canonicalize(input));
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

async function verificationResult(
  db: D1Database,
  requestId: string,
  repository: string,
): Promise<{
  requestId: string;
  workflowRunUrl: string;
  status: string;
} | null> {
  const row = await db
    .prepare("SELECT request_id, status FROM verification_requests WHERE request_id = ?")
    .bind(requestId)
    .first<{ request_id: string; status: string }>();
  return row
    ? {
        requestId: row.request_id,
        workflowRunUrl: verificationWorkflowUrl(repository),
        status: row.status,
      }
    : null;
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
  operationId: z.string().catch(""),
  notionPageIdOrUrl: z.string().catch(""),
});

const mcpGetTaskStatusInputSchema = z.object({
  taskId: z.string().catch(""),
});

const mcpLinkPullRequestInputSchema = z.object({
  operationId: z.string().catch(""),
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
  operationId: z.string().catch(""),
  taskId: z.string().catch(""),
  repository: z.string().catch(""),
  environment: z.string().catch(""),
  commitSha: z.string().catch(""),
});

const mcpInvestigateIncidentInputSchema = z.object({
  sentryIssueUrlOrId: z.string().catch(""),
});

const mcpCreateNotionIssueInputSchema = z.object({
  operationId: z.string().catch(""),
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
  | "NOTION_STATUS_UPDATE_FAILED"
  | "OPERATION_CONFLICT"
  | "OPERATION_RECONCILE_REQUIRED"
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
  if (message === "NOTION_STATUS_UPDATE_FAILED") {
    return "NOTION_STATUS_UPDATE_FAILED";
  }
  if (message === "OPERATION_CONFLICT") return "OPERATION_CONFLICT";
  if (message === "OPERATION_RECONCILE_REQUIRED") {
    return "OPERATION_RECONCILE_REQUIRED";
  }
  if (message === "SENTRY_AUTH_FAILED") return "SENTRY_AUTH_FAILED";
  if (message === "SENTRY_FORBIDDEN") return "SENTRY_FORBIDDEN";
  if (message === "SENTRY_NOT_FOUND") return "SENTRY_NOT_FOUND";
  if (message === "SENTRY_RATE_LIMITED") return "SENTRY_RATE_LIMITED";
  if (message === "SENTRY_READ_FAILED") return "SENTRY_READ_FAILED";
  return "INPUT_INVALID";
}
