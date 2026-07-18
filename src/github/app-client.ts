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
  state: string;
}

interface CheckRunsApiResponse {
  check_runs: Array<{ status: string; conclusion: string | null }>;
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
        this.request<ReviewApiResponse[]>(
          `${path}/pulls/${reference.number}/reviews?per_page=100`,
          installationAuthentication.token,
        ),
        this.request<CheckRunsApiResponse>(
          `${path}/commits/${pullRequest.head.sha}/check-runs?per_page=100`,
          installationAuthentication.token,
        ),
      ]);
      return {
        repository: pullRequest.base.repo.full_name,
        number: pullRequest.number,
        url: pullRequest.html_url,
        headSha: pullRequest.head.sha,
        state: pullRequest.merged || pullRequest.merged_at ? "merged" : pullRequest.state,
        review: deriveReviewState(reviews),
        ci: deriveCiState(checks.check_runs),
      };
    } catch {
      throw new Error("GITHUB_READ_FAILED");
    }
  }

  async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    const rows = await this.db
      .prepare("SELECT pr_url FROM pull_requests WHERE task_id = ? ORDER BY pr_url")
      .bind(taskId)
      .all<{ pr_url: string }>();
    const pullRequests = await Promise.all(
      rows.results.map((row) => this.getPullRequest(row.pr_url)),
    );
    return {
      started: true,
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

export function createGitHubClient(
  env: Pick<Env, "DB" | "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">,
): GitHubAppClient {
  return new GitHubAppClient(env.DB, {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
  });
}

function deriveReviewState(
  reviews: ReviewApiResponse[],
): PullRequestSnapshot["review"] {
  const states = reviews.map((review) => review.state.toUpperCase());
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
