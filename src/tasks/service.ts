// Notion 이슈를 ProofOps 작업 연결로 시작하는 응용 서비스를 제공한다
import type { NotionPort } from "../notion/service";
import type { TaskContext, TaskRepository } from "./repository";

export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly notion: NotionPort,
  ) {}

  async startTask(pageIdOrUrl: string): Promise<TaskContext> {
    const issue = await this.notion.getIssue(pageIdOrUrl);
    const task = await this.tasks.upsertFromNotion(issue);
    try {
      await this.notion.updateTechnicalStatus(issue.pageId, "In Progress");
      await this.tasks.clearSyncError(task.id);
    } catch (error) {
      await this.tasks.recordSyncError(task.id, toSafeErrorMessage(error));
    }
    return this.tasks.getContext(task.id);
  }
}

export function toSafeErrorMessage(_error: unknown): string {
  return "NOTION_SYNC_FAILED";
}
