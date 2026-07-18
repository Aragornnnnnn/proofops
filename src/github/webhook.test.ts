// GitHub Webhook 서명, 멱등성, 현재 상태 수렴과 PR 연결을 검증한다
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import checkRunFailed from "../../test/fixtures/github-check-run-failed.json";
import pullRequestOpened from "../../test/fixtures/github-pull-request-opened.json";
import reviewChangesRequested from "../../test/fixtures/github-review-changes-requested.json";
import type { TaskSnapshot } from "../domain/types";
import type { VerificationResult } from "../domain/verification-result";
import type { GitHubPort, LinkedPullRequestSnapshot } from "./app-client";
import { handleGitHubWebhook, linkPullRequest } from "./webhook";

const secret = "webhook-test-secret";
const timestamp = "2026-07-18T00:00:00.000Z";
const verificationSha = "0123456789abcdef0123456789abcdef01234567";
const trustedWorkflowSha = "f".repeat(40);
const verificationRequestId = "11111111-1111-4111-8111-111111111111";
const verificationArtifact: VerificationResult = {
  schemaVersion: 1,
  requestId: verificationRequestId,
  taskId: "task-1",
  repository: "Aragornnnnnn/landit-be",
  environment: "develop",
  commitSha: verificationSha,
  status: "passed",
  checks: [
    {
      name: "deployment",
      status: "passed",
      evidenceUrl: "https://github.com/Aragornnnnnn/landit-be/actions/runs/101",
      summary: "배포가 안정 상태다.",
    },
    {
      name: "ecs",
      status: "passed",
      evidenceUrl: "https://github.com/Aragornnnnnn/landit-be/actions/runs/101",
      summary: "ECS 서비스가 안정 상태다.",
    },
    {
      name: "alb",
      status: "passed",
      evidenceUrl: "https://github.com/Aragornnnnnn/landit-be/actions/runs/101",
      summary: "ALB 대상이 healthy 상태다.",
    },
    {
      name: "api",
      status: "passed",
      evidenceUrl: "https://github.com/Aragornnnnnn/landit-be/actions/runs/101",
      summary: "상태 확인 API가 성공했다.",
    },
    { name: "sentry", status: "skipped", summary: "선택 관측 항목이다." },
  ],
  observedAt: timestamp,
};

function artifactForRun(
  runId: number,
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  const evidenceUrl =
    `https://github.com/Aragornnnnnn/landit-be/actions/runs/${runId}`;
  return {
    ...verificationArtifact,
    checks: verificationArtifact.checks.map((check) =>
      check.evidenceUrl ? { ...check, evidenceUrl } : check,
    ),
    ...overrides,
  };
}

function verificationWorkflowPayload(
  runId: number,
  requestId: string = verificationRequestId,
): Record<string, unknown> {
  return {
    action: "completed",
    workflow_run: {
      id: runId,
      path: ".github/workflows/proofops-verify.yml",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: trustedWorkflowSha,
      display_title: `ProofOps verification ${requestId}`,
      html_url:
        `https://github.com/Aragornnnnnn/landit-be/actions/runs/${runId}`,
      pull_requests: [],
    },
    repository: { full_name: "Aragornnnnnn/landit-be" },
  };
}
const currentPullRequest: LinkedPullRequestSnapshot = {
  repository: "Aragornnnnnn/landit-be",
  number: 42,
  url: "https://github.com/Aragornnnnnn/landit-be/pull/42",
  headSha: "current-api-sha",
  state: "open",
  review: "changes_requested",
  ci: "failed",
};
const currentTaskSnapshot: TaskSnapshot = {
  started: true,
  expectedRepositories: ["landit-be"],
  pullRequests: [currentPullRequest],
  deployment: "none",
  requiredVerification: "pending",
};

function githubStub(
  pullRequest: LinkedPullRequestSnapshot = currentPullRequest,
): GitHubPort {
  return {
    getPullRequest: vi.fn().mockResolvedValue(pullRequest),
    getTaskSnapshot: vi.fn().mockResolvedValue({
      ...currentTaskSnapshot,
      pullRequests: [pullRequest],
    }),
    dispatchVerification: vi.fn().mockRejectedValue(new Error("not used")),
    getVerificationArtifact: vi.fn().mockRejectedValue(new Error("not used")),
  };
}

const notionStub = {
  getIssue: vi.fn(),
  updateTechnicalStatus: vi.fn().mockResolvedValue(undefined),
  createIssue: vi.fn(),
};

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return `sha256=${Array.from(new Uint8Array(signature), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function webhookRequest(
  event: string,
  deliveryId: string,
  payload: unknown,
  signature?: string,
): Promise<Request> {
  const body = JSON.stringify(payload);
  return new Request("https://proofops.test/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature ?? (await sign(body)),
    },
    body,
  });
}

async function insertTaskAndPullRequest(): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO tasks (
          id, notion_page_id, notion_url, title, technical_status,
          expected_repositories, last_sync_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "task-1",
        "notion-page-1",
        "https://notion.so/notion-page-1",
        "GitHub 상태 연결",
        "In Review",
        '["landit-be"]',
        null,
        timestamp,
        timestamp,
      ),
    env.DB
      .prepare(
        `INSERT INTO pull_requests (
          id, task_id, repository, pr_number, pr_url, state,
          review_state, ci_state, head_sha, linked_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "pr-1",
        "task-1",
        "Aragornnnnnn/landit-be",
        42,
        "https://github.com/Aragornnnnnn/landit-be/pull/42",
        "open",
        "pending",
        "pending",
        "old-sha",
        timestamp,
        timestamp,
      ),
  ]);
}

async function insertVerificationRequest(
  input: {
    requestId?: string;
    taskId?: string;
    repository?: string;
    environment?: "develop" | "prod";
    commitSha?: string;
  } = {},
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO verification_requests (
        request_id, task_id, repository, environment, target_commit_sha,
        trusted_ref, status, workflow_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      input.requestId ?? verificationRequestId,
      input.taskId ?? "task-1",
      input.repository ?? "Aragornnnnnn/landit-be",
      input.environment ?? "develop",
      input.commitSha ?? verificationSha,
      "main",
      "dispatched",
      timestamp,
      timestamp,
    )
    .run();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        notion_page_id TEXT NOT NULL UNIQUE,
        notion_url TEXT NOT NULL,
        title TEXT NOT NULL,
        technical_status TEXT NOT NULL,
        expected_repositories TEXT NOT NULL DEFAULT '[]',
        last_sync_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS pull_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        pr_url TEXT NOT NULL,
        state TEXT NOT NULL,
        review_state TEXT NOT NULL,
        ci_state TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repository, pr_number)
      )`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        provider TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY(provider, delivery_id)
      )`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS verification_requests (
        request_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        repository TEXT NOT NULL,
        environment TEXT NOT NULL,
        target_commit_sha TEXT NOT NULL,
        trusted_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        workflow_run_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS verification_runs (
        id TEXT PRIMARY KEY,
        request_id TEXT REFERENCES verification_requests(request_id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        repository TEXT NOT NULL,
        environment TEXT NOT NULL,
        commit_sha TEXT NOT NULL DEFAULT '',
        workflow_run_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        evidence_url TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`),
  ]);
});

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pull_requests"),
    env.DB.prepare("DELETE FROM verification_runs"),
    env.DB.prepare("DELETE FROM verification_requests"),
    env.DB.prepare("DELETE FROM webhook_deliveries"),
    env.DB.prepare("DELETE FROM tasks"),
  ]);
});

describe("handleGitHubWebhook", () => {
  it("서명 불일치는 저장 전에 401로 거부한다", async () => {
    const github = githubStub();
    const response = await handleGitHubWebhook(
      await webhookRequest(
        "pull_request",
        "delivery-invalid",
        pullRequestOpened,
        "sha256=00",
      ),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ status: "invalid_signature" });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries").first(),
    ).resolves.toEqual({ count: 0 });
    expect(github.getPullRequest).not.toHaveBeenCalled();
  });

  it("같은 delivery 재전송을 202 duplicate로 처리한다", async () => {
    await insertTaskAndPullRequest();
    const github = githubStub();
    const first = await handleGitHubWebhook(
      await webhookRequest("pull_request", "delivery-duplicate", pullRequestOpened),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );
    const second = await handleGitHubWebhook(
      await webhookRequest("pull_request", "delivery-duplicate", pullRequestOpened),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toEqual({ status: "duplicate" });
    expect(github.getPullRequest).toHaveBeenCalledTimes(1);
  });

  it("지원하지 않는 이벤트를 202 ignored로 반환하고 delivery를 저장하지 않는다", async () => {
    const github = githubStub();
    const response = await handleGitHubWebhook(
      await webhookRequest("issues", "delivery-ignored", { action: "opened" }),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "ignored" });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries").first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("순서가 뒤바뀐 이벤트도 payload가 아닌 GitHub 현재 상태로 수렴한다", async () => {
    await insertTaskAndPullRequest();
    const github = githubStub();
    const events = [
      ["check_run", checkRunFailed],
      ["pull_request_review", reviewChangesRequested],
      ["pull_request", pullRequestOpened],
    ] as const;

    for (const [index, [event, payload]] of events.entries()) {
      const response = await handleGitHubWebhook(
        await webhookRequest(event, `delivery-${index}`, payload),
        { db: env.DB, webhookSecret: secret, github, notion: notionStub },
      );
      expect(response.status).toBe(202);
    }

    await expect(
      env.DB
        .prepare(
          "SELECT state, review_state, ci_state, head_sha FROM pull_requests WHERE id = ?",
        )
        .bind("pr-1")
        .first(),
    ).resolves.toEqual({
      state: "open",
      review_state: "changes_requested",
      ci_state: "failed",
      head_sha: "current-api-sha",
    });
    expect(github.getPullRequest).toHaveBeenCalledTimes(3);
  });

  it("PR 저장 뒤 재조정 실패를 재전송하면 변경이 없어도 작업 상태를 복구한다", async () => {
    await insertTaskAndPullRequest();
    const github = githubStub();
    vi.mocked(github.getTaskSnapshot)
      .mockRejectedValueOnce(new Error("temporary GitHub failure"))
      .mockResolvedValueOnce(currentTaskSnapshot);

    const first = await handleGitHubWebhook(
      await webhookRequest("pull_request", "delivery-retry", pullRequestOpened),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );
    const second = await handleGitHubWebhook(
      await webhookRequest("pull_request", "delivery-retry", pullRequestOpened),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(first.status).toBe(502);
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toEqual({ status: "processed" });
    await expect(
      env.DB
        .prepare("SELECT technical_status FROM tasks WHERE id = ?")
        .bind("task-1")
        .first(),
    ).resolves.toEqual({ technical_status: "Blocked" });
    expect(github.getTaskSnapshot).toHaveBeenCalledTimes(2);
  });

  it("Notion 갱신 실패와 무관하게 processed를 반환하고 안전한 오류를 저장한다", async () => {
    await insertTaskAndPullRequest();
    const github = githubStub();
    notionStub.updateTechnicalStatus.mockRejectedValueOnce(
      new Error("secret-bearing Notion response"),
    );

    const response = await handleGitHubWebhook(
      await webhookRequest("pull_request", "delivery-notion-failure", pullRequestOpened),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "processed" });
    await expect(
      env.DB
        .prepare("SELECT technical_status, last_sync_error FROM tasks WHERE id = ?")
        .bind("task-1")
        .first(),
    ).resolves.toEqual({
      technical_status: "Blocked",
      last_sync_error: "NOTION_SYNC_FAILED",
    });
  });

  it("다음 Webhook은 계산된 상태가 같아도 Notion 동기화를 재시도한다", async () => {
    await insertTaskAndPullRequest();
    const github = githubStub();
    notionStub.updateTechnicalStatus.mockRejectedValueOnce(
      new Error("temporary Notion failure"),
    );

    await handleGitHubWebhook(
      await webhookRequest("pull_request", "delivery-notion-retry-1", pullRequestOpened),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );
    await handleGitHubWebhook(
      await webhookRequest("pull_request", "delivery-notion-retry-2", pullRequestOpened),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(notionStub.updateTechnicalStatus).toHaveBeenCalledTimes(2);
    await expect(
      env.DB
        .prepare("SELECT technical_status, last_sync_error FROM tasks WHERE id = ?")
        .bind("task-1")
        .first(),
    ).resolves.toEqual({ technical_status: "Blocked", last_sync_error: null });
  });

  it("PR이 없는 workflow_run은 Task 7까지 ignored로 처리한다", async () => {
    const response = await handleGitHubWebhook(
      await webhookRequest("workflow_run", "delivery-workflow", {
        action: "completed",
        workflow_run: { pull_requests: [] },
        repository: { full_name: "Aragornnnnnn/landit-iac" },
      }),
      {
        db: env.DB,
        webhookSecret: secret,
        github: githubStub(),
        notion: notionStub,
      },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "ignored" });
  });

  it("PR 참조가 없는 검증 workflow_run도 request ID로 결과를 저장한다", async () => {
    await insertTaskAndPullRequest();
    await insertVerificationRequest();
    await env.DB
      .prepare("UPDATE pull_requests SET head_sha = ?, state = 'merged' WHERE id = ?")
      .bind(verificationSha, "pr-1")
      .run();
    const github = githubStub() as GitHubPort & {
      getVerificationArtifact: ReturnType<typeof vi.fn>;
    };
    github.getVerificationArtifact = vi.fn().mockResolvedValue(artifactForRun(101));

    const response = await handleGitHubWebhook(
      await webhookRequest(
        "workflow_run",
        "delivery-verification",
        verificationWorkflowPayload(101),
      ),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "processed" });
    expect(github.getVerificationArtifact).toHaveBeenCalledWith({
      repository: "Aragornnnnnn/landit-be",
      workflowRunId: 101,
      requestId: verificationRequestId,
    });
    await expect(
      env.DB
        .prepare(
          "SELECT request_id, task_id, repository, environment, commit_sha, workflow_run_id, status, evidence_url, result_json FROM verification_runs",
        )
        .first(),
    ).resolves.toEqual({
      request_id: verificationRequestId,
      task_id: "task-1",
      repository: "Aragornnnnnn/landit-be",
      environment: "develop",
      commit_sha: verificationSha,
      workflow_run_id: 101,
      status: "passed",
      evidence_url:
        "https://github.com/Aragornnnnnn/landit-be/actions/runs/101",
      result_json: JSON.stringify(artifactForRun(101)),
    });
    await expect(
      env.DB
        .prepare(
          "SELECT status, workflow_run_id FROM verification_requests WHERE request_id = ?",
        )
        .bind(verificationRequestId)
        .first(),
    ).resolves.toEqual({ status: "passed", workflow_run_id: 101 });
  });

  it("필수 check가 unobservable인 결과는 Failed 상태로 수렴한다", async () => {
    await insertTaskAndPullRequest();
    await insertVerificationRequest();
    await env.DB
      .prepare("UPDATE pull_requests SET head_sha = ?, state = 'merged' WHERE id = ?")
      .bind(verificationSha, "pr-1")
      .run();
    const github = githubStub() as GitHubPort & {
      getVerificationArtifact: ReturnType<typeof vi.fn>;
    };
    github.getVerificationArtifact = vi.fn().mockResolvedValue({
      ...artifactForRun(102),
      status: "unobservable",
      checks: artifactForRun(102).checks.map((check) =>
        check.name === "ecs"
          ? { ...check, status: "unobservable", summary: "ECS를 관측하지 못했다." }
          : check,
      ),
    });
    vi.mocked(github.getTaskSnapshot).mockImplementation(async () => {
      const run = await env.DB
        .prepare("SELECT status FROM verification_runs WHERE task_id = ?")
        .bind("task-1")
        .first<{ status: "passed" | "failed" }>();
      return {
        ...currentTaskSnapshot,
        pullRequests: [
          { ...currentPullRequest, state: "merged", review: "approved", ci: "passed" },
        ],
        deployment: "succeeded",
        requiredVerification: run?.status ?? "pending",
      };
    });

    const response = await handleGitHubWebhook(
      await webhookRequest(
        "workflow_run",
        "delivery-unobservable",
        verificationWorkflowPayload(102),
      ),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(response.status).toBe(202);
    await expect(
      env.DB.prepare("SELECT status FROM verification_runs").first(),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      env.DB
        .prepare("SELECT technical_status FROM tasks WHERE id = ?")
        .bind("task-1")
        .first(),
    ).resolves.toEqual({ technical_status: "Failed" });
  });

  it("문맥이 확인된 invalid artifact는 원문 없이 안전한 실패로 수렴한다", async () => {
    await insertTaskAndPullRequest();
    await insertVerificationRequest();
    await env.DB
      .prepare("UPDATE pull_requests SET head_sha = ?, state = 'merged' WHERE id = ?")
      .bind(verificationSha, "pr-1")
      .run();
    const github = githubStub();
    vi.mocked(github.getVerificationArtifact).mockResolvedValue({
      ...artifactForRun(103),
      taskId: "attacker-task",
      checks: [
        {
          name: "api",
          status: "passed",
          summary: "AWS_ACCESS_KEY_ID=AKIA0123456789ABCDEF",
        },
      ],
    });
    vi.mocked(github.getTaskSnapshot).mockImplementation(async () => {
      const run = await env.DB
        .prepare("SELECT status FROM verification_runs WHERE task_id = ?")
        .bind("task-1")
        .first<{ status: "failed" }>();
      return {
        ...currentTaskSnapshot,
        requiredVerification: run?.status ?? "pending",
      };
    });

    const response = await handleGitHubWebhook(
      await webhookRequest(
        "workflow_run",
        "delivery-invalid-artifact",
        verificationWorkflowPayload(103),
      ),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "processed" });
    await expect(
      env.DB
        .prepare("SELECT environment, status, result_json FROM verification_runs")
        .first(),
    ).resolves.toEqual({
      environment: "unknown",
      status: "failed",
      result_json: JSON.stringify({ error: "VERIFICATION_ARTIFACT_INVALID" }),
    });
    await expect(
      env.DB
        .prepare("SELECT technical_status FROM tasks WHERE id = ?")
        .bind("task-1")
        .first(),
    ).resolves.toEqual({ technical_status: "Failed" });
  });

  it("artifact API의 일시 실패는 delivery를 되돌리고 재시도한다", async () => {
    await insertTaskAndPullRequest();
    await insertVerificationRequest();
    await env.DB
      .prepare("UPDATE pull_requests SET head_sha = ? WHERE id = ?")
      .bind(verificationSha, "pr-1")
      .run();
    const github = githubStub();
    vi.mocked(github.getVerificationArtifact).mockRejectedValue(
      new Error("GITHUB_API_FAILED"),
    );

    const response = await handleGitHubWebhook(
      await webhookRequest(
        "workflow_run",
        "delivery-artifact-retry",
        verificationWorkflowPayload(104),
      ),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ status: "retry" });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM verification_runs").first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB
        .prepare(
          "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE delivery_id = ?",
        )
        .bind("delivery-artifact-retry")
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("같은 저장소와 SHA를 공유하는 다른 작업으로 결과가 교차 귀속되지 않는다", async () => {
    await insertTaskAndPullRequest();
    await insertVerificationRequest();
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO tasks (
            id, notion_page_id, notion_url, title, technical_status,
            expected_repositories, last_sync_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "task-2",
          "notion-page-2",
          "https://notion.so/notion-page-2",
          "같은 SHA 작업",
          "Verifying",
          '["landit-be"]',
          null,
          timestamp,
          timestamp,
        ),
      env.DB
        .prepare(
          `INSERT INTO pull_requests (
            id, task_id, repository, pr_number, pr_url, state,
            review_state, ci_state, head_sha, linked_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "pr-2",
          "task-2",
          "Aragornnnnnn/landit-be",
          43,
          "https://github.com/Aragornnnnnn/landit-be/pull/43",
          "merged",
          "approved",
          "passed",
          verificationSha,
          "2026-07-18T00:01:00.000Z",
          "2026-07-18T00:01:00.000Z",
        ),
    ]);
    const github = githubStub();
    vi.mocked(github.getVerificationArtifact).mockResolvedValue(artifactForRun(105));

    const response = await handleGitHubWebhook(
      await webhookRequest(
        "workflow_run",
        "delivery-no-cross-attribution",
        verificationWorkflowPayload(105),
      ),
      { db: env.DB, webhookSecret: secret, github, notion: notionStub },
    );

    expect(response.status).toBe(202);
    await expect(
      env.DB
        .prepare("SELECT task_id, request_id FROM verification_runs")
        .first(),
    ).resolves.toEqual({
      task_id: "task-1",
      request_id: verificationRequestId,
    });
  });
});

describe("linkPullRequest", () => {
  it("adapter allowlist에 없는 저장소는 GitHub 조회 전에 거부한다", async () => {
    const github = githubStub();

    await expect(
      linkPullRequest(
        {
          taskId: "task-1",
          pullRequestUrl: "https://github.com/attacker/other/pull/1",
        },
        { db: env.DB, github, notion: notionStub },
      ),
    ).rejects.toThrow("GITHUB_REPOSITORY_NOT_ALLOWED");
    expect(github.getPullRequest).not.toHaveBeenCalled();
  });

  it("허용 저장소와 basename이 같아도 다른 owner이면 조회 전에 거부한다", async () => {
    const github = githubStub();

    await expect(
      linkPullRequest(
        {
          taskId: "task-1",
          pullRequestUrl: "https://github.com/attacker/landit-be/pull/42",
        },
        { db: env.DB, github, notion: notionStub },
      ),
    ).rejects.toThrow("GITHUB_REPOSITORY_NOT_ALLOWED");
    expect(github.getPullRequest).not.toHaveBeenCalled();
  });

  it("허용 PR을 GitHub 현재 상태로 연결하고 작업 상태를 재계산한다", async () => {
    await env.DB
      .prepare(
        `INSERT INTO tasks (
          id, notion_page_id, notion_url, title, technical_status,
          expected_repositories, last_sync_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "task-1",
        "notion-page-1",
        "https://notion.so/notion-page-1",
        "GitHub 상태 연결",
        "In Progress",
        '["landit-be"]',
        null,
        timestamp,
        timestamp,
      )
      .run();
    const github = githubStub({
      ...currentPullRequest,
      review: "pending",
      ci: "passed",
    });

    const context = await linkPullRequest(
      {
        taskId: "task-1",
        pullRequestUrl: "https://github.com/Aragornnnnnn/landit-be/pull/42",
      },
      { db: env.DB, github, notion: notionStub },
    );

    expect(context).toMatchObject({ id: "task-1", technicalStatus: "In Review" });
    await expect(
      env.DB
        .prepare("SELECT repository, pr_number, head_sha FROM pull_requests")
        .first(),
    ).resolves.toEqual({
      repository: "Aragornnnnnn/landit-be",
      pr_number: 42,
      head_sha: "current-api-sha",
    });
  });
});
