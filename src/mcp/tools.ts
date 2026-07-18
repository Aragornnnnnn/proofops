// ProofOps 작업 서비스를 MCP 도구 호출로 안전하게 연결한다
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import adapter from "../../landit/adapter.json";
import type { Env } from "../env";
import { createGitHubClient, type GitHubPort } from "../github/app-client";
import { linkPullRequest, reconcileTask } from "../github/webhook";
import { createNotionClient } from "../notion/client";
import type { TaskContext } from "../tasks/repository";
import { D1TaskRepository } from "../tasks/repository";
import { TaskService } from "../tasks/service";
import {
  getTaskStatusInputSchema,
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
}

export function createProofOpsTools(env: Env): ProofOpsTools {
  const tasks = new D1TaskRepository(env.DB);
  const notion = createNotionClient(env);
  const github = createGitHubClient(env);
  const taskService = new TaskService(tasks, notion, (taskId) =>
    reconcileTask({ db: env.DB, github, notion }, taskId),
  );

  return {
    startTask: ({ notionPageIdOrUrl }) => taskService.startTask(notionPageIdOrUrl),
    linkPullRequest: (input) =>
      linkPullRequest(input, { db: env.DB, github, notion }),
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
      await env.DB
        .prepare(
          `INSERT INTO progress_notes (id, task_id, kind, summary, evidence_url, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          note.id,
          note.taskId,
          note.kind,
          note.summary,
          note.evidenceUrl,
          note.createdAt,
        )
        .run();
      return note;
    },
    async requestVerification(input) {
      await tasks.getContext(input.taskId);
      return requestVerification(input, { db: env.DB, github });
    },
  };
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
  | "INPUT_INVALID" {
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
  return "INPUT_INVALID";
}
