// D1 작업 연결 저장소의 생성, PR 재연결, 웹훅 중복 방지를 검증한다
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  D1TaskRepository,
  createTask,
  recordWebhookDelivery,
  upsertPullRequest,
} from "./repository";

const createdAt = "2026-07-18T00:00:00.000Z";

beforeEach(async () => {
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

describe("D1 작업 연결 저장소", () => {
  it("Notion 작업을 생성한다", async () => {
    await createTask(env.DB, {
      id: "task-1",
      notionPageId: "notion-page-1",
      notionUrl: "https://notion.so/task-1",
      title: "상태 계산 구현",
      technicalStatus: "In Progress",
      expectedRepositories: ["proofops/proofops"],
      createdAt,
      updatedAt: createdAt,
    });

    await expect(
      env.DB
        .prepare("SELECT notion_page_id, expected_repositories FROM tasks WHERE id = ?")
        .bind("task-1")
        .first(),
    ).resolves.toEqual({
      notion_page_id: "notion-page-1",
      expected_repositories: '["proofops/proofops"]',
    });
  });

  it("같은 Notion 이슈는 기존 작업을 반환한다", async () => {
    const repository = new D1TaskRepository(env.DB, () => createdAt, () => "task-1");
    const issue = {
      pageId: "notion-page-1",
      url: "https://notion.so/task-1",
      title: "상태 계산 구현",
      description: "상태를 계산한다.",
      acceptanceCriteria: [],
      repositories: ["proofops/proofops"],
      currentTechnicalStatus: null,
    };

    const first = await repository.upsertFromNotion(issue);
    const second = await repository.upsertFromNotion({ ...issue, title: "변경된 제목" });

    expect(first).toMatchObject({ id: "task-1", title: "상태 계산 구현" });
    expect(second).toEqual(first);
  });

  it("같은 저장소와 번호의 PR을 재연결한다", async () => {
    await createTask(env.DB, {
      id: "task-1",
      notionPageId: "notion-page-1",
      notionUrl: "https://notion.so/task-1",
      title: "상태 계산 구현",
      technicalStatus: "In Progress",
      expectedRepositories: [],
      createdAt,
      updatedAt: createdAt,
    });

    await upsertPullRequest(env.DB, {
      id: "pr-1",
      taskId: "task-1",
      repository: "proofops/proofops",
      prNumber: 42,
      prUrl: "https://github.com/proofops/proofops/pull/42",
      state: "open",
      reviewState: "pending",
      ciState: "pending",
      headSha: "first-sha",
      updatedAt: createdAt,
    });
    await upsertPullRequest(env.DB, {
      id: "pr-2",
      taskId: "task-1",
      repository: "proofops/proofops",
      prNumber: 42,
      prUrl: "https://github.com/proofops/proofops/pull/42",
      state: "merged",
      reviewState: "approved",
      ciState: "passed",
      headSha: "second-sha",
      updatedAt: "2026-07-18T00:10:00.000Z",
    });

    await expect(
      env.DB
        .prepare("SELECT id, state, ci_state, head_sha FROM pull_requests")
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          id: "pr-1",
          state: "merged",
          ci_state: "passed",
          head_sha: "second-sha",
        },
      ],
    });
  });

  it("중복 웹훅 전달은 false를 반환한다", async () => {
    await expect(
      recordWebhookDelivery(env.DB, {
        provider: "github",
        deliveryId: "delivery-1",
        receivedAt: createdAt,
      }),
    ).resolves.toBe(true);
    await expect(
      recordWebhookDelivery(env.DB, {
        provider: "github",
        deliveryId: "delivery-1",
        receivedAt: createdAt,
      }),
    ).resolves.toBe(false);
  });
});
