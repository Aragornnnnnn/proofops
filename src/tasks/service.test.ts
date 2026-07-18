// Notion 작업 시작과 동기화 실패 격리를 검증한다
import { describe, expect, it, vi } from "vitest";
import type { NotionIssue, NotionPort } from "../notion/service";
import type { SharedTaskContext, TaskContext, TaskRecord, TaskRepository } from "./repository";
import { TaskService } from "./service";

const issue: NotionIssue = {
  pageId: "notion-page-1",
  url: "https://www.notion.so/notion-page-1",
  title: "상태 계산 구현",
  description: "상태를 갱신한다.",
  acceptanceCriteria: ["상태가 반영된다"],
  repositories: ["landit/landit-be"],
  currentTechnicalStatus: null,
};

const task: TaskRecord = {
  id: "task-1",
  notionPageId: issue.pageId,
  notionUrl: issue.url,
  title: issue.title,
  technicalStatus: "In Progress",
  expectedRepositories: issue.repositories,
  lastSyncError: null,
};

const context: TaskContext = {
  ...task,
  missingRepositories: [],
};

function createTasks(): TaskRepository {
  return {
    upsertFromNotion: vi.fn().mockResolvedValue(task),
    clearSyncError: vi.fn().mockResolvedValue(undefined),
    recordSyncError: vi.fn().mockResolvedValue(undefined),
    getContext: vi.fn().mockResolvedValue(context),
    getSharedContext: vi.fn().mockResolvedValue({
      ...context,
      pullRequests: [],
      progress: [],
      verification: [],
    } satisfies SharedTaskContext),
  };
}

function createNotion(): NotionPort {
  return {
    getIssue: vi.fn().mockResolvedValue(issue),
    updateTechnicalStatus: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn(),
  };
}

describe("TaskService", () => {
  it("Notion 이슈를 작업으로 연결하고 In Progress를 반영한다", async () => {
    const tasks = createTasks();
    const notion = createNotion();

    await expect(new TaskService(tasks, notion).startTask(issue.url)).resolves.toEqual(context);
    expect(tasks.upsertFromNotion).toHaveBeenCalledWith(issue);
    expect(notion.updateTechnicalStatus).toHaveBeenCalledWith(issue.pageId, "In Progress");
    expect(tasks.clearSyncError).toHaveBeenCalledWith(task.id);
  });

  it("상태 동기화 실패는 안전한 오류만 저장하고 작업 시작은 반환한다", async () => {
    const tasks = createTasks();
    const notion = createNotion();
    const token = "secret-notion-token";
    vi.mocked(notion.updateTechnicalStatus).mockRejectedValue(
      new Error(`Authorization: Bearer ${token}; response: {"private":"value"}`),
    );

    await expect(new TaskService(tasks, notion).startTask(issue.pageId)).resolves.toEqual(context);
    expect(tasks.recordSyncError).toHaveBeenCalledWith(task.id, "NOTION_SYNC_FAILED");
    expect(tasks.recordSyncError).not.toHaveBeenCalledWith(
      task.id,
      expect.stringContaining(token),
    );
  });

  it("기존 Notion 상태 이름과 무관하게 adapter 상태 매핑으로 동기화한다", async () => {
    const tasks = createTasks();
    const notion = createNotion();
    vi.mocked(notion.getIssue).mockResolvedValue({
      ...issue,
      currentTechnicalStatus: "기존 사용자 정의 상태",
    });

    await new TaskService(tasks, notion).startTask(issue.pageId);

    expect(notion.updateTechnicalStatus).toHaveBeenCalledWith(issue.pageId, "In Progress");
  });

  it("상태 조회는 동일한 재조정 경로를 거쳐 계산된 상태를 반환한다", async () => {
    const tasks = createTasks();
    const notion = createNotion();
    const calculatedContext: TaskContext = {
      ...context,
      technicalStatus: "Blocked",
      lastSyncError: "NOTION_SYNC_FAILED",
      missingRepositories: ["landit-ai"],
    };
    vi.mocked(tasks.getContext).mockResolvedValue(calculatedContext);
    const reconcile = vi.fn().mockResolvedValue(undefined);

    await expect(new TaskService(tasks, notion, reconcile).getTaskStatus(task.id)).resolves.toMatchObject({
      technicalStatus: "Blocked",
      missingRepositories: ["landit-ai"],
    });
    expect(reconcile).toHaveBeenCalledWith(task.id);
  });

  it("저장된 증거로 결정적인 인수인계를 만들고 추측성 진행 메모는 확정 사실로 올리지 않는다", async () => {
    const tasks = createTasks();
    const notion = createNotion();
    vi.mocked(tasks.getSharedContext).mockResolvedValue({
      ...context,
      missingRepositories: ["landit-ai"],
      lastSyncError: "NOTION_SYNC_FAILED",
      pullRequests: [
        {
          url: "https://github.com/landit/landit-ai/pull/4",
          repository: "landit/landit-ai",
          state: "open",
          reviewState: "changes_requested",
          ciState: "failed",
        },
        {
          url: "https://github.com/landit/landit-be/pull/3",
          repository: "landit/landit-be",
          state: "merged",
          reviewState: "approved",
          ciState: "passed",
        },
      ],
      progress: [
        { id: "test-1", taskId: task.id, kind: "test", summary: "unit test failed", evidenceUrl: null, createdAt: "2026-07-18T01:00:00.000Z" },
        { id: "chat-1", taskId: task.id, kind: "decision", summary: "AI가 원인은 캐시라고 추측함", evidenceUrl: null, createdAt: "2026-07-18T02:00:00.000Z" },
        { id: "block-1", taskId: task.id, kind: "blocker", summary: "배포 권한 대기", evidenceUrl: null, createdAt: "2026-07-18T03:00:00.000Z" },
      ],
      verification: [
        {
          repository: "landit/landit-ai",
          environment: "develop",
          status: "failed",
          evidenceUrl: "https://github.com/landit/landit-ai/actions/runs/1",
          checks: "api: failed",
        },
        {
          repository: "landit/landit-be",
          environment: "develop",
          status: "pending",
          evidenceUrl: null,
          checks: "pending",
        },
      ],
    });

    await expect(new TaskService(tasks, notion, undefined, () => "2026-07-18T04:00:00.000Z").createHandoff(task.id)).resolves.toEqual({
      requirement: {
        title: issue.title,
        url: issue.url,
        acceptanceCriteria: issue.acceptanceCriteria,
      },
      confirmedFacts: [
        "Pull request https://github.com/landit/landit-ai/pull/4 is open with changes_requested review and failed checks.",
        "Pull request https://github.com/landit/landit-be/pull/3 is merged with approved review and passed checks.",
        "Verification for landit/landit-ai in develop failed.",
        "Verification for landit/landit-be in develop is pending.",
      ],
      pullRequests: [
        { url: "https://github.com/landit/landit-ai/pull/4", repository: "landit/landit-ai", state: "open", checks: "changes_requested; failed" },
        { url: "https://github.com/landit/landit-be/pull/3", repository: "landit/landit-be", state: "merged", checks: "approved; passed" },
      ],
      tests: [{ id: "test-1", taskId: task.id, kind: "test", summary: "unit test failed", evidenceUrl: null, createdAt: "2026-07-18T01:00:00.000Z" }],
      deploymentAndVerification: [
        { repository: "landit/landit-ai", environment: "develop", status: "failed", evidenceUrl: "https://github.com/landit/landit-ai/actions/runs/1", checks: "api: failed" },
        { repository: "landit/landit-be", environment: "develop", status: "pending", evidenceUrl: null, checks: "pending" },
      ],
      blockers: ["배포 권한 대기", "NOTION_SYNC_FAILED"],
      nextActions: [
        "Address requested changes in https://github.com/landit/landit-ai/pull/4.",
        "Fix failed checks for landit/landit-ai.",
        "Link pull request for landit-ai.",
        "Retry Notion synchronization.",
        "Wait for verification for landit/landit-be.",
      ],
      generatedAt: "2026-07-18T04:00:00.000Z",
    });
  });
});
