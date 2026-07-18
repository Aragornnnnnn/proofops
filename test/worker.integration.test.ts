// Worker의 기본 HTTP 동작을 검증하는 통합 테스트
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const mcpHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

async function postMcp(message: unknown, sessionId?: string): Promise<Response> {
  return SELF.fetch("https://proofops.test/mcp", {
    method: "POST",
    headers: {
      ...mcpHeaders,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
}

async function readMcpResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);

  if (!data) throw new Error("MCP response did not include JSON data");
  return JSON.parse(data) as Record<string, unknown>;
}

async function initializeMcp(): Promise<string> {
  const response = await postMcp({
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "proofops-test", version: "1.0.0" },
    },
  });

  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP initialization did not provide a session ID");
  await expect(readMcpResponse(response)).resolves.toMatchObject({
    jsonrpc: "2.0",
    id: "initialize",
    result: { serverInfo: { name: "proofops" } },
  });
  return sessionId;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        notion_page_id TEXT NOT NULL UNIQUE,
        notion_url TEXT NOT NULL,
        title TEXT NOT NULL,
        technical_status TEXT NOT NULL,
        expected_repositories TEXT NOT NULL,
        last_sync_error TEXT
      )`),
    env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS progress_notes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_url TEXT,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS pull_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        pr_url TEXT NOT NULL,
        state TEXT NOT NULL,
        review_state TEXT NOT NULL,
        ci_state TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
    env.DB.prepare("DELETE FROM pull_requests"),
    env.DB.prepare("DELETE FROM progress_notes"),
    env.DB.prepare("DELETE FROM tasks"),
  ]);
});

describe("GET /health", () => {
  it("서비스 상태를 반환한다", async () => {
    const response = await SELF.fetch("https://proofops.test/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "proofops",
      status: "ok",
      environment: env.ENVIRONMENT,
    });
  });
});

describe("POST /mcp", () => {
  it("초기화 후 정확히 네 MCP 도구를 공개한다", async () => {
    const sessionId = await initializeMcp();

    const toolsResponse = await postMcp(
      { jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} },
      sessionId,
    );

    expect(toolsResponse.status).toBe(200);
    const tools = await readMcpResponse(toolsResponse);
    expect(tools).toMatchObject({
      jsonrpc: "2.0",
      id: "tools",
      result: {
        tools: [
          { name: "start_task" },
          { name: "link_pull_request" },
          { name: "get_task_status" },
          { name: "record_progress" },
        ],
      },
    });
    expect((tools.result as { tools: unknown[] }).tools).toHaveLength(4);
  });

  it("네 도구가 안정된 오류 코드로 실패를 반환한다", async () => {
    const sessionId = await initializeMcp();
    const calls = [
      [
        "start",
        "start_task",
        { notionPageIdOrUrl: "11111111-1111-1111-1111-111111111111" },
        "NOTION_READ_FAILED",
      ],
      [
        "link",
        "link_pull_request",
        {
          taskId: "missing-task",
          pullRequestUrl: "https://github.com/attacker/other/pull/1",
        },
        "GITHUB_REPOSITORY_NOT_ALLOWED",
      ],
      ["status", "get_task_status", { taskId: "missing-task" }, "TASK_NOT_FOUND"],
      [
        "progress",
        "record_progress",
        { taskId: "missing-task", kind: "test", summary: "테스트 통과" },
        "TASK_NOT_FOUND",
      ],
      [
        "invalid-progress",
        "record_progress",
        { taskId: "missing-task", kind: "test", summary: "a".repeat(1_001) },
        "INPUT_INVALID",
      ],
    ] as const;

    for (const [id, name, arguments_, expectedCode] of calls) {
      const response = await postMcp(
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: arguments_ },
        },
        sessionId,
      );

      expect(response.status).toBe(200);
      await expect(readMcpResponse(response)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: expectedCode }],
        },
      });
    }
  });

  it("record_progress 결과의 JSON 텍스트와 structuredContent를 일치시킨다", async () => {
    await env.DB
      .prepare(
        `INSERT INTO tasks (
          id, notion_page_id, notion_url, title, technical_status,
          expected_repositories, last_sync_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "task-1",
        "notion-page-1",
        "https://www.notion.so/notion-page-1",
        "MCP 진행 기록",
        "In Progress",
        "[]",
        null,
      )
      .run();
    const sessionId = await initializeMcp();
    const response = await postMcp(
      {
        jsonrpc: "2.0",
        id: "record",
        method: "tools/call",
        params: {
          name: "record_progress",
          arguments: {
            taskId: "task-1",
            kind: "test",
            summary: "통합 테스트 통과",
            evidenceUrl: "https://example.com/build/1",
          },
        },
      },
      sessionId,
    );

    expect(response.status).toBe(200);
    const result = await readMcpResponse(response);
    const toolResult = result.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(toolResult.structuredContent).toMatchObject({
      taskId: "task-1",
      kind: "test",
      summary: "통합 테스트 통과",
      evidenceUrl: "https://example.com/build/1",
    });
    expect(JSON.parse(toolResult.content[0].text)).toEqual(toolResult.structuredContent);
  });
});
