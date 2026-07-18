// GitHub App 인증으로 Pull Request의 현재 리뷰와 Check 상태를 조회한다
import { createAppAuth } from "@octokit/auth-app";
import { strFromU8, unzipSync } from "fflate";
import adapter from "../../landit/adapter.json";
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
  requestId: string;
  taskId: string;
  repository: string;
  environment: "develop" | "prod";
  commitSha: string;
}

export interface GitHubPort {
  getPullRequest(url: string): Promise<LinkedPullRequestSnapshot>;
  getTaskSnapshot(taskId: string): Promise<TaskSnapshot>;
  dispatchVerification(
    input: VerificationRequest,
  ): Promise<{ workflowRunUrl: string }>;
  getVerificationArtifact(input: {
    repository: string;
    workflowRunId: number;
    requestId: string;
  }): Promise<unknown>;
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
    const verificationRows = await this.db
      .prepare(
        `SELECT repository, commit_sha, status FROM verification_runs
         WHERE task_id = ? ORDER BY workflow_run_id DESC`,
      )
      .bind(taskId)
      .all<{ repository: string; commit_sha: string; status: string }>();
    const selectedShaByRepository = new Map(
      pullRequests.map((pullRequest) => [
        repositoryName(pullRequest.repository),
        pullRequest.headSha.toLowerCase(),
      ]),
    );
    const latestVerificationByRepository = new Map<string, "passed" | "failed">();
    for (const row of verificationRows.results) {
      const name = repositoryName(row.repository);
      if (
        typeof row.commit_sha === "string" &&
        row.commit_sha.toLowerCase() === selectedShaByRepository.get(name) &&
        !latestVerificationByRepository.has(name) &&
        (row.status === "passed" || row.status === "failed")
      ) {
        latestVerificationByRepository.set(name, row.status);
      }
    }
    const requiredRepositoryNames =
      expectedNames.size > 0
        ? [...expectedNames]
        : [...latestPullRequestUrls.keys()];
    const verificationStatuses = requiredRepositoryNames
      .map((name) => latestVerificationByRepository.get(name))
      .filter((status): status is "passed" | "failed" => status !== undefined);
    const requiredVerification = verificationStatuses.includes("failed")
      ? "failed"
      : requiredRepositoryNames.length > 0 &&
          verificationStatuses.length === requiredRepositoryNames.length
        ? "passed"
        : "pending";
    return {
      started: true,
      expectedRepositories,
      pullRequests,
      deployment: requiredVerification === "passed" ? "succeeded" : "none",
      requiredVerification,
    };
  }

  async dispatchVerification(
    input: VerificationRequest,
  ): Promise<{ workflowRunUrl: string }> {
    const [owner, repositoryName] = assertVerificationRequest(input);
    const token = await this.getInstallationToken(owner, repositoryName);
    const workflow = adapter.verificationWorkflow;
    await this.requestVoid(
      `/repos/${owner}/${repositoryName}/actions/workflows/${workflow}/dispatches`,
      token,
      {
        ref: adapter.verificationRef,
        inputs: {
          request_id: input.requestId,
          task_id: input.taskId,
          environment: input.environment,
          commit_sha: input.commitSha,
        },
      },
    );
    return {
      workflowRunUrl: `https://github.com/${owner}/${repositoryName}/actions/workflows/${workflow}`,
    };
  }

  async getVerificationArtifact(input: {
    repository: string;
    workflowRunId: number;
    requestId: string;
  }): Promise<unknown> {
    const [owner, repositoryName] = assertAllowedRepository(input.repository);
    if (
      !Number.isSafeInteger(input.workflowRunId) ||
      input.workflowRunId < 1 ||
      !isUuid(input.requestId)
    ) {
      throw new Error("INPUT_INVALID");
    }
    const token = await this.getInstallationToken(owner, repositoryName);
    const artifacts = await this.request<{
      artifacts: Array<{ id: number; name: string; expired: boolean }>;
    }>(
      `/repos/${owner}/${repositoryName}/actions/runs/${input.workflowRunId}/artifacts?per_page=100`,
      token,
    );
    const artifact = artifacts.artifacts.find(
      (candidate) =>
        candidate.name === `proofops-verification-${input.requestId}` &&
        !candidate.expired,
    );
    if (!artifact) throw new Error("GITHUB_VERIFICATION_ARTIFACT_INVALID");

    const response = await this.fetcher(
      `https://api.github.com/repos/${owner}/${repositoryName}/actions/artifacts/${artifact.id}/zip`,
      {
        headers: this.githubHeaders(token),
        redirect: "manual",
      },
    );
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      throw new Error("GITHUB_API_FAILED");
    }
    const downloadUrl = assertArtifactDownloadUrl(location);
    const download = await this.fetcher(downloadUrl, { redirect: "error" });
    if (!download.ok) throw new Error("GITHUB_API_FAILED");
    const declaredSize = Number(download.headers.get("content-length") ?? "0");
    if (declaredSize > 1_048_576) {
      await download.body?.cancel();
      throw new Error("GITHUB_VERIFICATION_ARTIFACT_INVALID");
    }
    const archive = await readLimitedBody(download, 1_048_576);
    try {
      let matchedFiles = 0;
      const files = unzipSync(archive, {
        filter: (file) => {
          if (file.name !== "proofops-verification-result.json") return false;
          matchedFiles += 1;
          if (file.originalSize > 262_144) {
            throw new Error("artifact too large");
          }
          return true;
        },
      });
      const result = files["proofops-verification-result.json"];
      if (matchedFiles !== 1 || !result) throw new Error("artifact missing");
      return JSON.parse(strFromU8(result));
    } catch {
      throw new Error("GITHUB_VERIFICATION_ARTIFACT_INVALID");
    }
  }

  private async getInstallationToken(
    owner: string,
    repositoryName: string,
  ): Promise<string> {
    const auth = createAppAuth({
      appId: this.config.appId,
      privateKey: this.config.privateKey.replaceAll("\\n", "\n"),
    });
    const appAuthentication = await auth({ type: "app" });
    const installation = await this.request<{ id: number }>(
      `/repos/${owner}/${repositoryName}/installation`,
      appAuthentication.token,
    );
    const installationAuthentication = await auth({
      type: "installation",
      installationId: installation.id,
    });
    return installationAuthentication.token;
  }

  private async request<T>(path: string, token: string): Promise<T> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      headers: this.githubHeaders(token),
    });
    if (!response.ok) throw new Error("GITHUB_API_FAILED");
    return (await response.json()) as T;
  }

  private githubHeaders(token: string): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "proofops",
      "x-github-api-version": "2022-11-28",
    };
  }

  private async requestVoid(
    path: string,
    token: string,
    body: unknown,
  ): Promise<void> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "proofops",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("GITHUB_API_FAILED");
  }
}

function assertVerificationRequest(input: VerificationRequest): [string, string] {
  const [owner, repositoryName] = assertAllowedRepository(input.repository);
  if (
    (input.environment !== "develop" && input.environment !== "prod") ||
    !input.taskId.trim() ||
    !isUuid(input.requestId) ||
    !/^[0-9a-f]{40}$/i.test(input.commitSha)
  ) {
    throw new Error("INPUT_INVALID");
  }
  return [owner, repositoryName];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function assertArtifactDownloadUrl(location: string): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new Error("GITHUB_VERIFICATION_ARTIFACT_INVALID");
  }
  const host = url.hostname.toLowerCase();
  const actionsHost =
    /^(?:pipelines|pipelinesgh[a-z0-9-]*|results-receiver)\.actions\.githubusercontent\.com$/.test(
      host,
    );
  const blobHost =
    /^productionresultssa(?:[0-9]|1[0-9])\.blob\.core\.windows\.net$/.test(host);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (!actionsHost && !blobHost)
  ) {
    throw new Error("GITHUB_VERIFICATION_ARTIFACT_INVALID");
  }
  return url.toString();
}

async function readLimitedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("GITHUB_VERIFICATION_ARTIFACT_INVALID");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertAllowedRepository(repository: string): [string, string] {
  const allowedRepository = adapter.allowedRepositories.find(
    (allowed) => allowed.toLowerCase() === repository.toLowerCase(),
  );
  if (!allowedRepository) throw new Error("GITHUB_REPOSITORY_NOT_ALLOWED");
  const [owner, repositoryName] = allowedRepository.split("/");
  return [owner, repositoryName];
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
