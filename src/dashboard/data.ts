// 대시보드에 필요한 최근 작업과 연결 증거를 D1에서 읽는다
export interface DashboardPullRequest {
  repository: string;
  number: number;
  url: string;
  state: string;
  reviewState: string;
  ciState: string;
}

export interface DashboardVerification {
  repository: string;
  environment: string;
  status: string;
  evidenceUrl: string;
  checks: string;
}

export interface DashboardTask {
  id: string;
  title: string;
  notionUrl: string;
  technicalStatus: string;
  expectedRepositories: string[];
  updatedAt: string;
  pullRequests: DashboardPullRequest[];
  verifications: DashboardVerification[];
}

export interface DashboardData {
  tasks: DashboardTask[];
}

interface TaskRow {
  id: string;
  title: string;
  notion_url: string;
  technical_status: string;
  expected_repositories: string;
  updated_at: string;
}

interface PullRequestRow {
  task_id: string;
  repository: string;
  pr_number: number;
  pr_url: string;
  state: string;
  review_state: string;
  ci_state: string;
}

interface VerificationRow {
  task_id: string;
  repository: string;
  environment: string;
  status: string;
  evidence_url: string;
  result_json: string;
}

export async function loadDashboard(db: D1Database): Promise<DashboardData> {
  const taskRows = await db
    .prepare(
      `SELECT id, title, notion_url, technical_status, expected_repositories, updated_at
       FROM tasks ORDER BY updated_at DESC, id DESC LIMIT 50`,
    )
    .all<TaskRow>();
  if (taskRows.results.length === 0) return { tasks: [] };
  const taskIds = new Set(taskRows.results.map(({ id }) => id));
  const [pullRequestRows, verificationRows] = await Promise.all([
    db
      .prepare(
        `SELECT task_id, repository, pr_number, pr_url, state, review_state, ci_state
         FROM pull_requests ORDER BY updated_at DESC, pr_number DESC`,
      )
      .all<PullRequestRow>(),
    db
      .prepare(
        `SELECT task_id, repository, environment, status, evidence_url, result_json
         FROM verification_runs ORDER BY created_at DESC, id DESC`,
      )
      .all<VerificationRow>(),
  ]);
  const latestVerificationKeys = new Set<string>();
  const tasks = taskRows.results.map((row) => ({
    id: row.id,
    title: row.title,
    notionUrl: row.notion_url,
    technicalStatus: row.technical_status,
    expectedRepositories: parseRepositories(row.expected_repositories),
    updatedAt: row.updated_at,
    pullRequests: pullRequestRows.results
      .filter((pullRequest) => pullRequest.task_id === row.id)
      .map((pullRequest) => ({
        repository: pullRequest.repository,
        number: pullRequest.pr_number,
        url: pullRequest.pr_url,
        state: pullRequest.state,
        reviewState: pullRequest.review_state,
        ciState: pullRequest.ci_state,
      })),
    verifications: verificationRows.results
      .filter((verification) => {
        if (!taskIds.has(verification.task_id) || verification.task_id !== row.id) {
          return false;
        }
        const key = `${verification.task_id}\0${verification.repository}\0${verification.environment}`;
        if (latestVerificationKeys.has(key)) return false;
        latestVerificationKeys.add(key);
        return true;
      })
      .map((verification) => ({
        repository: verification.repository,
        environment: verification.environment,
        status: verification.status,
        evidenceUrl: verification.evidence_url,
        checks: verificationChecks(verification.result_json, verification.status),
      })),
  }));
  return { tasks };
}

function parseRepositories(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function verificationChecks(value: string, fallback: string): string {
  try {
    const result = JSON.parse(value) as {
      checks?: Array<{ name?: unknown; status?: unknown }>;
    };
    const checks = result.checks
      ?.filter(
        (check): check is { name: string; status: string } =>
          typeof check.name === "string" && typeof check.status === "string",
      )
      .map((check) => `${check.name}: ${check.status}`)
      .join(", ");
    return checks || fallback;
  } catch {
    return fallback;
  }
}
