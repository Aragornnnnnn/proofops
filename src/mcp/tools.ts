// ProofOps 작업 서비스를 MCP 도구 호출로 안전하게 연결한다
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env } from "../env";
import { createGitHubClient } from "../github/app-client";
import { linkPullRequest } from "../github/webhook";
import { createNotionClient } from "../notion/client";
import type { TaskContext } from "../tasks/repository";
import { D1TaskRepository } from "../tasks/repository";
import { TaskService } from "../tasks/service";
import {
  getTaskStatusInputSchema,
  progressNoteSchema,
  recordProgressInputSchema,
  startTaskInputSchema,
  taskContextSchema,
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
}

export function createProofOpsTools(env: Env): ProofOpsTools {
  const tasks = new D1TaskRepository(env.DB);
  const notion = createNotionClient(env);
  const github = createGitHubClient(env);
  const taskService = new TaskService(tasks, notion);

  return {
    startTask: ({ notionPageIdOrUrl }) => taskService.startTask(notionPageIdOrUrl),
    linkPullRequest: (input) =>
      linkPullRequest(input, { db: env.DB, github, notion }),
    getTaskStatus: ({ taskId }) => tasks.getContext(taskId),
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
  };
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
  if (message === "GITHUB_REPOSITORY_NOT_ALLOWED") {
    return "GITHUB_REPOSITORY_NOT_ALLOWED";
  }
  if (message === "TASK_NOT_FOUND") return "TASK_NOT_FOUND";
  return "INPUT_INVALID";
}
