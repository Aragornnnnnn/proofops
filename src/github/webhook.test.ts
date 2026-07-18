// GitHub Webhook 서명, 멱등성, 현재 상태 수렴과 PR 연결을 검증한다
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import checkRunFailed from "../../test/fixtures/github-check-run-failed.json";
import pullRequestOpened from "../../test/fixtures/github-pull-request-opened.json";
import reviewChangesRequested from "../../test/fixtures/github-review-changes-requested.json";
import type { TaskSnapshot } from "../domain/types";
import type { GitHubPort, LinkedPullRequestSnapshot } from "./app-client";
import { handleGitHubWebhook, linkPullRequest } from "./webhook";

const secret = "webhook-test-secret";
const timestamp = "2026-07-18T00:00:00.000Z";
const currentPullRequest: LinkedPullRequestSnapshot = {
  repository: "landit/landit-be",
  number: 42,
  url: "https://github.com/landit/landit-be/pull/42",
  headSha: "current-api-sha",
  state: "open",
  review: "changes_requested",
  ci: "failed",
};
const currentTaskSnapshot: TaskSnapshot = {
  started: true,
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
          review_state, ci_state, head_sha, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "pr-1",
        "task-1",
        "landit/landit-be",
        42,
        "https://github.com/landit/landit-be/pull/42",
        "open",
        "pending",
        "pending",
        "old-sha",
        timestamp,
      ),
  ]);
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
  ]);
});

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pull_requests"),
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
        pullRequestUrl: "https://github.com/landit/landit-be/pull/42",
      },
      { db: env.DB, github, notion: notionStub },
    );

    expect(context).toMatchObject({ id: "task-1", technicalStatus: "In Review" });
    await expect(
      env.DB
        .prepare("SELECT repository, pr_number, head_sha FROM pull_requests")
        .first(),
    ).resolves.toEqual({
      repository: "landit/landit-be",
      pr_number: 42,
      head_sha: "current-api-sha",
    });
  });
});
