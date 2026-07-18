// Notion 이슈를 ProofOps 작업 연결로 시작하는 응용 서비스를 제공한다
import adapter from "../../landit/adapter.json";
import type { TechnicalStatus } from "../domain/types";
import type { NotionIssue, NotionPort } from "../notion/service";
import type { TaskContext, TaskRecord, TaskRepository } from "./repository";

export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly notion: NotionPort,
    private readonly reconcile?: (taskId: string) => Promise<void>,
  ) {}

  async startTask(pageIdOrUrl: string): Promise<TaskContext> {
    const issue = await this.notion.getIssue(pageIdOrUrl);
    return this.startTaskFromIssue(issue);
  }

  async startTaskFromIssue(issue: NotionIssue): Promise<TaskContext> {
    const task = await this.tasks.upsertFromNotion(issue);
    await this.syncTechnicalStatus(task);
    return this.tasks.getContext(task.id);
  }

  async getTaskStatus(taskId: string): Promise<TaskContext> {
    const task = await this.tasks.getContext(taskId);
    if (this.reconcile) {
      await this.reconcile(taskId);
      return this.tasks.getContext(taskId);
    }
    await this.syncTechnicalStatus(task);
    return this.tasks.getContext(taskId);
  }

  private async syncTechnicalStatus(task: TaskRecord): Promise<void> {
    try {
      await this.notion.updateTechnicalStatus(
        task.notionPageId,
        mapTechnicalStatusForNotion(task.technicalStatus),
      );
      await this.tasks.clearSyncError(task.id);
    } catch {
      await this.tasks.recordSyncError(task.id, toSafeErrorMessage(undefined));
    }
  }
}

export function mapTechnicalStatusForNotion(status: TechnicalStatus): string {
  const mappedStatus = adapter.statusMapping[status];
  if (!mappedStatus) throw new Error("NOTION_STATUS_MAPPING_MISSING");
  return mappedStatus;
}

export function toSafeErrorMessage(_error: unknown): string {
  return "NOTION_SYNC_FAILED";
}
