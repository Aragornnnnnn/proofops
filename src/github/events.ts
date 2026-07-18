// GitHub Webhook 이벤트에서 연결된 Pull Request 참조를 안전하게 추출한다
import adapter from "../../landit/adapter.json";

export const supportedGitHubEvents = new Set([
  "pull_request",
  "pull_request_review",
  "check_run",
  "workflow_run",
]);

export interface PullRequestReference {
  owner: string;
  repositoryName: string;
  repository: string;
  number: number;
  url: string;
}

export function parsePullRequestUrl(url: string): PullRequestReference {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("INPUT_INVALID");
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    !match
  ) {
    throw new Error("INPUT_INVALID");
  }
  const [, owner, repositoryName, numberText] = match;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("INPUT_INVALID");
  return {
    owner,
    repositoryName,
    repository: `${owner}/${repositoryName}`,
    number,
    url: `https://github.com/${owner}/${repositoryName}/pull/${number}`,
  };
}

export function assertAllowedPullRequest(url: string): PullRequestReference {
  const reference = parsePullRequestUrl(url);
  const allowed = adapter.allowedRepositories.some(
    (repository) => repository.toLowerCase() === reference.repository.toLowerCase(),
  );
  if (!allowed) throw new Error("GITHUB_REPOSITORY_NOT_ALLOWED");
  return reference;
}

export function extractPullRequestUrl(event: string, payload: unknown): string | null {
  const object = asObject(payload);
  const directPullRequest = asObject(object?.pull_request);
  const directUrl = directPullRequest?.html_url;
  if (typeof directUrl === "string") return directUrl;

  if (event !== "check_run" && event !== "workflow_run") return null;
  const source = asObject(object?.[event]);
  const pullRequests = source?.pull_requests;
  const firstPullRequest = Array.isArray(pullRequests)
    ? asObject(pullRequests[0])
    : null;
  const number = firstPullRequest?.number;
  const repository = asObject(object?.repository)?.full_name;
  if (
    typeof repository !== "string" ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    return null;
  }
  return `https://github.com/${repository}/pull/${number}`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
