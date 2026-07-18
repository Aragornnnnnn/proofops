// Notion 이슈를 ProofOps 작업 연결로 시작하는 응용 서비스를 제공한다
import adapter from "../../landit/adapter.json";
import type { TechnicalStatus } from "../domain/types";
import type { NotionIssue, NotionPort } from "../notion/service";
import type {
  ProgressNote,
  TaskContext,
  TaskRecord,
  TaskRepository,
  VerificationSummary,
} from "./repository";

export interface Handoff {
  requirement: { title: string; url: string; acceptanceCriteria: string[] };
  confirmedFacts: string[];
  pullRequests: Array<{ url: string; repository: string; state: string; checks: string }>;
  tests: ProgressNote[];
  deploymentAndVerification: VerificationSummary[];
  blockers: string[];
  nextActions: string[];
  generatedAt: string;
}

export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly notion: NotionPort,
    private readonly reconcile?: (taskId: string) => Promise<void>,
    private readonly now: () => string = () => new Date().toISOString(),
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

  async getContext(taskId: string) {
    return this.tasks.getSharedContext(taskId);
  }

  async createHandoff(taskId: string): Promise<Handoff> {
    const context = await this.tasks.getSharedContext(taskId);
    const issue = await this.notion.getIssue(context.notionPageId);
    const pullRequests = context.pullRequests.map((pullRequest) => ({
      url: pullRequest.url,
      repository: pullRequest.repository,
      state: pullRequest.state,
      checks: `${pullRequest.reviewState}; ${pullRequest.ciState}`,
    }));
    const confirmedFacts = [
      ...context.pullRequests.map(
        (pullRequest) =>
          `Pull request ${pullRequest.url} is ${pullRequest.state} with ${pullRequest.reviewState} review and ${pullRequest.ciState} checks.`,
      ),
      ...context.verification.map(
        (verification) =>
          verification.status === "pending"
            ? `Verification for ${verification.repository} in ${verification.environment} is pending.`
            : `Verification for ${verification.repository} in ${verification.environment} ${verification.status}.`,
      ),
    ];
    return {
      requirement: {
        title: issue.title,
        url: issue.url,
        acceptanceCriteria: issue.acceptanceCriteria,
      },
      confirmedFacts,
      pullRequests,
      tests: context.progress.filter((note) => note.kind === "test"),
      deploymentAndVerification: context.verification,
      blockers: [
        ...context.progress.filter((note) => note.kind === "blocker").map((note) => note.summary),
        ...(context.lastSyncError ? [context.lastSyncError] : []),
      ],
      nextActions: nextActions(context),
      generatedAt: this.now(),
    };
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

function nextActions(context: Awaited<ReturnType<TaskRepository["getSharedContext"]>>): string[] {
  return [
    ...context.missingRepositories.map((repository) => `Link pull request for ${repository}.`),
    ...context.pullRequests
      .filter((pullRequest) => pullRequest.reviewState === "changes_requested")
      .map((pullRequest) => `Address requested changes in ${pullRequest.url}.`),
    ...context.pullRequests
      .filter((pullRequest) => pullRequest.ciState === "failed")
      .map((pullRequest) => `Fix failed checks for ${pullRequest.repository}.`),
    ...context.verification
      .filter((verification) => verification.status === "failed")
      .map((verification) => `Fix failed checks for ${verification.repository}.`),
    ...context.verification
      .filter((verification) => verification.status === "pending")
      .map((verification) => `Wait for verification for ${verification.repository}.`),
    ...(context.lastSyncError ? ["Retry Notion synchronization."] : []),
  ].filter((action, index, actions) => actions.indexOf(action) === index).sort();
}

export function mapTechnicalStatusForNotion(status: TechnicalStatus): string {
  const mappedStatus = adapter.statusMapping[status];
  if (!mappedStatus) throw new Error("NOTION_STATUS_MAPPING_MISSING");
  return mappedStatus;
}

export function toSafeErrorMessage(_error: unknown): string {
  return "NOTION_SYNC_FAILED";
}
