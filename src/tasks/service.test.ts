// Notion 작업 시작과 동기화 실패 격리를 검증한다
import { describe, expect, it, vi } from "vitest";
import type { NotionIssue, NotionPort } from "../notion/service";
import type { TaskContext, TaskRecord, TaskRepository } from "./repository";
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
});
