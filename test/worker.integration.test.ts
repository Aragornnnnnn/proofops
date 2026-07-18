// Worker의 기본 HTTP 동작을 검증하는 통합 테스트
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sentryIssue from "./fixtures/sentry-issue.json";

const mcpHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};
const sessionTokens = new Map<string, string>();

async function postMcp(
  message: unknown,
  sessionId?: string,
  accessToken?: string,
): Promise<Response> {
  const bearerToken = accessToken ?? (sessionId ? sessionTokens.get(sessionId) : undefined);
  return SELF.fetch("https://proofops.test/mcp", {
    method: "POST",
    headers: {
      ...mcpHeaders,
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
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

interface AuthorizationFixture {
  clientId: string;
  verifier: string;
  downstreamRedirectUri: string;
  githubState: string;
}

interface ConsentForm {
  actorGithubUserId: string;
  clientId: string;
  csrfToken: string;
  redirectUri: string;
  scopes: string;
}

async function beginAuthorization(scope = "mcp"): Promise<AuthorizationFixture> {
  const downstreamRedirectUri = "https://client.example/oauth/callback";
  const clientId = await registerOAuthClient(downstreamRedirectUri);
  const verifier = "proofops-test-verifier-abcdefghijklmnopqrstuvwxyz123456";
  const authorizeUrl = await authorizationUrl(clientId, downstreamRedirectUri, verifier, scope);

  const response = await SELF.fetch(authorizeUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  const githubUrl = new URL(requiredHeader(response, "location"));
  expect(githubUrl.origin).toBe("https://github.com");
  expect(githubUrl.pathname).toBe("/login/oauth/authorize");

  return {
    clientId,
    verifier,
    downstreamRedirectUri,
    githubState: requiredQuery(githubUrl, "state"),
  };
}

async function registerOAuthClient(redirectUri: string): Promise<string> {
  const registration = await SELF.fetch("https://proofops.test/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ProofOps test client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registration.status).toBe(201);
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  return clientId;
}

async function authorizationUrl(
  clientId: string,
  redirectUri: string,
  verifier: string,
  scope: string,
): Promise<URL> {
  const challenge = await pkceChallenge(verifier);
  const authorizeUrl = new URL("https://proofops.test/authorize");
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: "downstream-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return authorizeUrl;
}

async function renderConsent(
  fixture: AuthorizationFixture,
  profile: { id: number; login: string } = { id: 101, login: "Alice" },
): Promise<Response> {
  const previousFetch = globalThis.fetch;
  const upstreamFetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "github-access-token", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") return Response.json(profile);
    throw new Error(`Unexpected upstream request: ${url}`);
  });
  vi.stubGlobal("fetch", upstreamFetch);
  try {
    return await SELF.fetch(
      `https://proofops.test/oauth/callback?code=github-code&state=${encodeURIComponent(fixture.githubState)}`,
      { redirect: "manual" },
    );
  } finally {
    vi.stubGlobal("fetch", previousFetch);
  }
}

async function approvedAccessToken(
  profile: { id: number; login: string } = { id: 101, login: "Alice" },
  tokenScope?: string,
): Promise<string> {
  const fixture = await beginAuthorization();
  const consent = await renderConsent(fixture, profile);
  expect(consent.status).toBe(200);
  const form = parseConsentForm(await consent.text());
  const approved = await submitConsent(form, "approve");
  expect(approved.status).toBe(302);
  const downstream = new URL(requiredHeader(approved, "location"));
  const code = requiredQuery(downstream, "code");
  const token = await SELF.fetch("https://proofops.test/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: fixture.clientId,
      code,
      redirect_uri: fixture.downstreamRedirectUri,
      code_verifier: fixture.verifier,
      ...(tokenScope === undefined ? {} : { scope: tokenScope }),
    }),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as { access_token: string };
  return body.access_token;
}

async function submitConsent(
  form: ConsentForm,
  decision: "approve" | "deny",
  overrides: Partial<ConsentForm> = {},
): Promise<Response> {
  return SELF.fetch("https://proofops.test/authorize", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, ...overrides, decision }),
  });
}

function parseConsentForm(html: string): ConsentForm {
  return {
    actorGithubUserId: hiddenValue(html, "actorGithubUserId"),
    clientId: hiddenValue(html, "clientId"),
    csrfToken: hiddenValue(html, "csrfToken"),
    redirectUri: hiddenValue(html, "redirectUri"),
    scopes: hiddenValue(html, "scopes"),
  };
}

function hiddenValue(html: string, name: keyof ConsentForm): string {
  const value = html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];
  if (!value) throw new Error(`Consent form did not include ${name}`);
  return value;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`Response did not include ${name}`);
  return value;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`URL did not include ${name}`);
  return value;
}

async function initializeMcp(accessToken?: string): Promise<string> {
  const bearerToken = accessToken ?? (await approvedAccessToken());
  const response = await postMcp({
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "proofops-test", version: "1.0.0" },
    },
  }, undefined, bearerToken);

  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP initialization did not provide a session ID");
  sessionTokens.set(sessionId, bearerToken);
  await expect(readMcpResponse(response)).resolves.toMatchObject({
    jsonrpc: "2.0",
    id: "initialize",
    result: { serverInfo: { name: "proofops" } },
  });
  return sessionId;
}

beforeEach(async () => {
  sessionTokens.clear();
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
      actor_github_user_id INTEGER,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS oauth_ephemeral_states (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        actor_github_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'succeeded',
        idempotency_key TEXT,
        updated_at TEXT,
        error_code TEXT,
        operation_id TEXT,
        input_hash TEXT
      )`),
    env.DB.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS audit_events_idempotency_key_idx
      ON audit_events(idempotency_key) WHERE idempotency_key IS NOT NULL`),
    env.DB.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS audit_events_operation_id_idx
      ON audit_events(operation_id) WHERE operation_id IS NOT NULL`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS mcp_sessions (
        session_id TEXT PRIMARY KEY,
        actor_github_user_id INTEGER NOT NULL,
        actor_github_login TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
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
    env.DB.prepare("DELETE FROM oauth_ephemeral_states"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM mcp_sessions"),
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

describe("POST /webhooks/github", () => {
  it("Bearer token 없이도 유효한 서명 요청을 처리한다", async () => {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const signature = await webhookSignature(body, env.GITHUB_WEBHOOK_SECRET);

    const response = await SELF.fetch("https://proofops.test/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "ignored" });
  });
});

describe("GitHub OAuth consent", () => {
  it("명시적 승인 전에는 downstream grant를 발급하지 않는다", async () => {
    const before = await env.OAUTH_KV.list({ prefix: "grant:" });
    const fixture = await beginAuthorization();
    const response = await renderConsent(fixture);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("ProofOps test client");
    expect(html).toContain("https://client.example");
    expect(html).toContain("mcp");
    const after = await env.OAUTH_KV.list({ prefix: "grant:" });
    expect(after.keys).toHaveLength(before.keys.length);
  });

  it("allowlist에 없는 GitHub 사용자를 callback state를 보존해 거부한다", async () => {
    const fixture = await beginAuthorization();
    const response = await renderConsent(fixture, { id: 404, login: "mallory" });

    expect(response.status).toBe(302);
    const redirect = new URL(requiredHeader(response, "location"));
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("downstream-state");
  });

  it("지원하지 않는 추가 scope를 callback state를 보존해 거부한다", async () => {
    const redirectUri = "https://client.example/oauth/callback";
    const clientId = await registerOAuthClient(redirectUri);
    const url = await authorizationUrl(
      clientId,
      redirectUri,
      "proofops-test-verifier-abcdefghijklmnopqrstuvwxyz123456",
      "mcp admin",
    );

    const response = await SELF.fetch(url, { redirect: "manual" });

    expect(response.status).toBe(302);
    const redirect = new URL(requiredHeader(response, "location"));
    expect(redirect.searchParams.get("error")).toBe("invalid_scope");
    expect(redirect.searchParams.get("state")).toBe("downstream-state");
  });

  it("지원하지 않는 response type을 callback state를 보존해 거부한다", async () => {
    const redirectUri = "https://client.example/oauth/callback";
    const clientId = await registerOAuthClient(redirectUri);
    const url = await authorizationUrl(
      clientId,
      redirectUri,
      "proofops-test-verifier-abcdefghijklmnopqrstuvwxyz123456",
      "mcp",
    );
    url.searchParams.set("response_type", "token");

    const response = await SELF.fetch(url, { redirect: "manual" });

    expect(response.status).toBe(302);
    const redirect = new URL(requiredHeader(response, "location"));
    expect(redirect.searchParams.get("error")).toBe("invalid_request");
    expect(redirect.searchParams.get("state")).toBe("downstream-state");
  });

  it("GitHub가 인증을 거절하면 access_denied와 callback state를 반환한다", async () => {
    const fixture = await beginAuthorization();

    const response = await SELF.fetch(
      `https://proofops.test/oauth/callback?error=access_denied&state=${encodeURIComponent(fixture.githubState)}`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    const redirect = new URL(requiredHeader(response, "location"));
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("downstream-state");
  });

  it("GitHub token 교환 실패는 server_error와 callback state를 반환한다", async () => {
    const fixture = await beginAuthorization();
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("failed", { status: 502 })));
    try {
      const response = await SELF.fetch(
        `https://proofops.test/oauth/callback?code=github-code&state=${encodeURIComponent(fixture.githubState)}`,
        { redirect: "manual" },
      );

      expect(response.status).toBe(302);
      const redirect = new URL(requiredHeader(response, "location"));
      expect(redirect.searchParams.get("error")).toBe("server_error");
      expect(redirect.searchParams.get("state")).toBe("downstream-state");
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });

  it.each([
    ["actorGithubUserId", "999"],
    ["clientId", "other-client"],
    ["redirectUri", "https://attacker.example/callback"],
    ["scopes", "mcp admin"],
  ] as const)("동의 토큰과 폼의 %s binding이 다르면 거부한다", async (field, value) => {
    const fixture = await beginAuthorization();
    const consent = await renderConsent(fixture);
    const form = parseConsentForm(await consent.text());

    const response = await submitConsent(form, "approve", { [field]: value });

    expect(response.status).toBe(403);
  });

  it("등록되지 않은 client는 GitHub 인증 전에 거부한다", async () => {
    const url = await authorizationUrl(
      "unknown-client",
      "https://client.example/oauth/callback",
      "proofops-test-verifier-abcdefghijklmnopqrstuvwxyz123456",
      "mcp",
    );

    const response = await SELF.fetch(url);

    expect(response.status).toBe(400);
  });

  it("등록되지 않은 redirect URI는 GitHub 인증 전에 거부한다", async () => {
    const registeredRedirect = "https://client.example/oauth/callback";
    const clientId = await registerOAuthClient(registeredRedirect);
    const url = await authorizationUrl(
      clientId,
      "https://attacker.example/callback",
      "proofops-test-verifier-abcdefghijklmnopqrstuvwxyz123456",
      "mcp",
    );

    const response = await SELF.fetch(url);

    expect(response.status).toBe(400);
  });

  it("만료된 동의 토큰을 거부한다", async () => {
    const fixture = await beginAuthorization();
    const consent = await renderConsent(fixture);
    const form = parseConsentForm(await consent.text());
    await env.DB
      .prepare("UPDATE oauth_ephemeral_states SET expires_at = 0 WHERE kind = 'consent'")
      .run();

    const response = await submitConsent(form, "approve");

    expect(response.status).toBe(403);
    await expect(
      env.DB
        .prepare("SELECT COUNT(*) AS count FROM oauth_ephemeral_states WHERE kind = 'consent'")
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("동의 토큰은 승인 뒤 재사용할 수 없다", async () => {
    const fixture = await beginAuthorization();
    const consent = await renderConsent(fixture);
    const form = parseConsentForm(await consent.text());

    expect((await submitConsent(form, "approve")).status).toBe(302);
    expect((await submitConsent(form, "approve")).status).toBe(403);
  });

  it("동시에 같은 동의 토큰을 소비해도 하나만 승인한다", async () => {
    const fixture = await beginAuthorization();
    const consent = await renderConsent(fixture);
    const form = parseConsentForm(await consent.text());

    const responses = await Promise.all([
      submitConsent(form, "approve"),
      submitConsent(form, "approve"),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([302, 403]);
  });

  it("거절하면 downstream token 발급 없이 access_denied로 돌아간다", async () => {
    const fixture = await beginAuthorization();
    const consent = await renderConsent(fixture);
    const form = parseConsentForm(await consent.text());

    const response = await submitConsent(form, "deny");

    expect(response.status).toBe(302);
    const redirect = new URL(requiredHeader(response, "location"));
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("downstream-state");
    expect(redirect.searchParams.has("code")).toBe(false);
  });

  it("승인된 사용자는 동의 뒤 MCP를 초기화할 수 있다", async () => {
    const accessToken = await approvedAccessToken();

    await expect(initializeMcp(accessToken)).resolves.toEqual(expect.any(String));
  });

  it("GitHub access token을 OAUTH_KV에 저장하지 않는다", async () => {
    const downstreamAccessToken = await approvedAccessToken();
    const keys = await env.OAUTH_KV.list();
    const values = await Promise.all(keys.keys.map(({ name }) => env.OAUTH_KV.get(name)));
    const d1Values = await env.DB
      .prepare("SELECT payload_json FROM oauth_ephemeral_states")
      .all<{ payload_json: string }>();

    expect(values.join("\n")).not.toContain("github-access-token");
    expect(values.join("\n")).not.toContain(downstreamAccessToken);
    expect(d1Values.results.map(({ payload_json }) => payload_json).join("\n")).not.toContain(
      "github-access-token",
    );
  });
});

describe("POST /mcp", () => {
  it("Bearer access token이 없으면 MCP 초기화를 거부한다", async () => {
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

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("mcp scope가 없는 실제 access token을 거부한다", async () => {
    const downscopedToken = await approvedAccessToken(
      { id: 101, login: "Alice" },
      "unknown",
    );

    const response = await postMcp(
      {
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "proofops-test", version: "1.0.0" },
        },
      },
      undefined,
      downscopedToken,
    );

    expect(response.status).toBe(403);
  });

  it("다른 actor가 기존 MCP session을 재사용하지 못하게 한다", async () => {
    const aliceToken = await approvedAccessToken({ id: 101, login: "Alice" });
    const bobToken = await approvedAccessToken({ id: 202, login: "Bob" });
    const sessionId = await initializeMcp(aliceToken);
    const listRequest = { jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} };

    const bobResponse = await postMcp(listRequest, sessionId, bobToken);
    const aliceResponse = await postMcp(listRequest, sessionId, aliceToken);

    expect(bobResponse.status).toBe(403);
    expect(aliceResponse.status).toBe(200);
  });

  it("만료된 MCP session binding을 정리하고 거부한다", async () => {
    const aliceToken = await approvedAccessToken({ id: 101, login: "Alice" });
    const sessionId = await initializeMcp(aliceToken);
    await env.DB
      .prepare("UPDATE mcp_sessions SET expires_at = 0 WHERE session_id = ?")
      .bind(sessionId)
      .run();

    const response = await postMcp(
      { jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} },
      sessionId,
      aliceToken,
    );

    expect(response.status).toBe(403);
    await expect(
      env.DB
        .prepare("SELECT COUNT(*) AS count FROM mcp_sessions WHERE session_id = ?")
        .bind(sessionId)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("초기화 후 정확히 일곱 MCP 도구를 공개한다", async () => {
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
          { name: "request_verification" },
          { name: "investigate_incident" },
          { name: "create_notion_issue" },
        ],
      },
    });
    expect((tools.result as { tools: unknown[] }).tools).toHaveLength(7);
  });

  it("일곱 도구가 안정된 오류 코드로 실패를 반환한다", async () => {
    const sessionId = await initializeMcp();
    const calls = [
      [
        "start",
        "start_task",
        {
          operationId: "20000000-0000-4000-8000-000000000001",
          notionPageIdOrUrl: "11111111-1111-1111-1111-111111111111",
        },
        "NOTION_READ_FAILED",
      ],
      [
        "link",
        "link_pull_request",
        {
          operationId: "20000000-0000-4000-8000-000000000002",
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
      [
        "invalid-verification",
        "request_verification",
        {
          taskId: "task-1",
          repository: "Aragornnnnnn/landit-be",
          environment: "stage",
          commitSha: "not-a-sha",
        },
        "INPUT_INVALID",
      ],
      [
        "invalid-incident",
        "investigate_incident",
        { sentryIssueUrlOrId: "" },
        "INPUT_INVALID",
      ],
      [
        "invalid-notion-issue",
        "create_notion_issue",
        {
          title: "",
          impact: "",
          evidence: [],
          causeOrHypothesis: "",
          scope: [],
          acceptanceCriteria: [],
        },
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
    await expect(
      env.DB
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE status = 'succeeded'")
        .first(),
    ).resolves.toEqual({ count: 0 });
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
    await expect(
      env.DB
        .prepare("SELECT actor_github_user_id FROM progress_notes WHERE task_id = ?")
        .bind("task-1")
        .first(),
    ).resolves.toEqual({ actor_github_user_id: 101 });
  });

  it("JSON-RPC 사건 조사 호출은 Notion 이슈를 생성하지 않는다", async () => {
    const upstreamFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/projects/landit/proofops/issues/")) {
        return Response.json([{ id: "12345" }]);
      }
      if (url === "https://sentry.io/api/0/issues/12345/") {
        return Response.json(sentryIssue);
      }
      if (url.startsWith("https://api.notion.com/")) {
        throw new Error("Notion create must not be called during investigation");
      }
      throw new Error(`Unexpected upstream request: ${url}`);
    });
    vi.stubGlobal("fetch", upstreamFetch);

    try {
      const sessionId = await initializeMcp();
      const response = await postMcp(
        {
          jsonrpc: "2.0",
          id: "investigate",
          method: "tools/call",
          params: {
            name: "investigate_incident",
            arguments: { sentryIssueUrlOrId: "12345" },
          },
        },
        sessionId,
      );

      expect(response.status).toBe(200);
      await expect(readMcpResponse(response)).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: "investigate",
        result: {
          structuredContent: { issueId: "12345", title: sentryIssue.title },
        },
      });
      expect(
        upstreamFetch.mock.calls.filter(([input]) =>
          String(input).startsWith("https://api.notion.com/"),
        ),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

async function webhookSignature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
