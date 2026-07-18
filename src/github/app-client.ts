// GitHub App 인증으로 Pull Request의 현재 리뷰와 Check 상태를 조회한다
import { createAppAuth } from "@octokit/auth-app";
import type { PullRequestSnapshot, TaskSnapshot } from "../domain/types";
import type { Env } from "../env";
import { parsePullRequestUrl } from "./events";

export interface LinkedPullRequestSnapshot extends PullRequestSnapshot {
  repository: string;
  number: number;
  url: string;
  headSha: string;
}

export interface VerificationRequest {
  taskId: string;
  repository: string;
  environment: "develop" | "prod";
  ref: string;
}

export interface GitHubPort {
  getPullRequest(url: string): Promise<LinkedPullRequestSnapshot>;
  getTaskSnapshot(taskId: string): Promise<TaskSnapshot>;
  dispatchVerification(
    input: VerificationRequest,
  ): Promise<{ workflowRunUrl: string }>;
}

interface GitHubAppConfig {
  appId: string;
  privateKey: string;
}

interface PullRequestApiResponse {
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  head: { sha: string };
  base: { repo: { full_name: string } };
  number: number;
}

interface ReviewApiResponse {
  id: number;
  user: { id: number } | null;
  state: string;
  submitted_at: string | null;
}

interface CheckRunsApiResponse {
  check_runs: Array<{ status: string; conclusion: string | null }>;
}

export interface GitHubReview {
  id: number;
  reviewerId: number | string;
  state: string;
  submittedAt: string | null;
}

export class GitHubAppClient implements GitHubPort {
  constructor(
    private readonly db: D1Database,
    private readonly config: GitHubAppConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getPullRequest(url: string): Promise<LinkedPullRequestSnapshot> {
    const reference = parsePullRequestUrl(url);
    try {
      const auth = createAppAuth({
        appId: this.config.appId,
        privateKey: this.config.privateKey.replaceAll("\\n", "\n"),
      });
      const appAuthentication = await auth({ type: "app" });
      const installation = await this.request<{ id: number }>(
        `/repos/${reference.owner}/${reference.repositoryName}/installation`,
        appAuthentication.token,
      );
      const installationAuthentication = await auth({
        type: "installation",
        installationId: installation.id,
      });
      const path = `/repos/${reference.owner}/${reference.repositoryName}`;
      const pullRequest = await this.request<PullRequestApiResponse>(
        `${path}/pulls/${reference.number}`,
        installationAuthentication.token,
      );
      const [reviews, checks] = await Promise.all([
        collectGitHubPages(async (page, perPage) => {
          const response = await this.request<ReviewApiResponse[]>(
            `${path}/pulls/${reference.number}/reviews?per_page=${perPage}&page=${page}`,
            installationAuthentication.token,
          );
          return response.map((review) => ({
            id: review.id,
            reviewerId: review.user?.id ?? `deleted-${review.id}`,
            state: review.state,
            submittedAt: review.submitted_at,
          }));
        }),
        collectGitHubPages(async (page, perPage) => {
          const response = await this.request<CheckRunsApiResponse>(
            `${path}/commits/${pullRequest.head.sha}/check-runs?per_page=${perPage}&page=${page}`,
            installationAuthentication.token,
          );
          return response.check_runs;
        }),
      ]);
      return {
        repository: pullRequest.base.repo.full_name,
        number: pullRequest.number,
        url: pullRequest.html_url,
        headSha: pullRequest.head.sha,
        state: pullRequest.merged || pullRequest.merged_at ? "merged" : pullRequest.state,
        review: deriveCurrentReviewState(reviews),
        ci: deriveCiState(checks),
      };
    } catch {
      throw new Error("GITHUB_READ_FAILED");
    }
  }

  async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    const rows = await this.db
      .prepare("SELECT repository, pr_url FROM pull_requests WHERE task_id = ? ORDER BY linked_at DESC, pr_number DESC")
      .bind(taskId)
      .all<{ repository: string; pr_url: string }>();
    const task = await this.db
      .prepare("SELECT expected_repositories FROM tasks WHERE id = ?")
      .bind(taskId)
      .first<{ expected_repositories: string }>();
    if (!task) throw new Error("TASK_NOT_FOUND");
    const expectedRepositories = JSON.parse(task.expected_repositories) as string[];
    const expectedNames = new Set(expectedRepositories.map(repositoryName));
    const latestPullRequestUrls = new Map<string, string>();
    for (const row of rows.results) {
      const name = repositoryName(row.repository);
      if (expectedNames.size > 0 && !expectedNames.has(name)) continue;
      if (!latestPullRequestUrls.has(name)) latestPullRequestUrls.set(name, row.pr_url);
    }
    const pullRequests = await Promise.all(
      [...latestPullRequestUrls.values()].map((prUrl) => this.getPullRequest(prUrl)),
    );
    return {
      started: true,
      expectedRepositories,
      pullRequests,
      deployment: "none",
      requiredVerification: "pending",
    };
  }

  async dispatchVerification(
    _input: VerificationRequest,
  ): Promise<{ workflowRunUrl: string }> {
    throw new Error("GITHUB_VERIFICATION_NOT_AVAILABLE");
  }

  private async request<T>(path: string, token: string): Promise<T> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "proofops",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error("GITHUB_API_FAILED");
    return (await response.json()) as T;
  }
}

function repositoryName(repository: string): string {
  return repository.trim().toLowerCase().split("/").at(-1) ?? "";
}

export function createGitHubClient(
  env: Pick<Env, "DB" | "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">,
): GitHubAppClient {
  return new GitHubAppClient(env.DB, {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
  });
}

export async function collectGitHubPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<T[]>,
): Promise<T[]> {
  const perPage = 100;
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const next = await fetchPage(page, perPage);
    items.push(...next);
    if (next.length < perPage) return items;
  }
}

export function deriveCurrentReviewState(
  reviews: GitHubReview[],
): PullRequestSnapshot["review"] {
  const latestByReviewer = new Map<number | string, GitHubReview>();
  const ordered = [...reviews].sort((left, right) => {
    const submitted = (left.submittedAt ?? "").localeCompare(
      right.submittedAt ?? "",
    );
    return submitted || left.id - right.id;
  });
  for (const review of ordered) {
    const state = review.state.toUpperCase();
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") continue;
    latestByReviewer.set(review.reviewerId, review);
  }
  const states = [...latestByReviewer.values()].map((review) =>
    review.state.toUpperCase(),
  );
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return "pending";
}

function deriveCiState(
  checks: CheckRunsApiResponse["check_runs"],
): PullRequestSnapshot["ci"] {
  if (checks.length === 0 || checks.some((check) => check.status !== "completed")) {
    return "pending";
  }
  const failedConclusions = new Set([
    "action_required",
    "cancelled",
    "failure",
    "startup_failure",
    "stale",
    "timed_out",
  ]);
  if (checks.some((check) => check.conclusion && failedConclusions.has(check.conclusion))) {
    return "failed";
  }
  return "passed";
}
