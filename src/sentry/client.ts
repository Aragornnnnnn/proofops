// Sentry 이슈를 고정된 조직과 프로젝트 범위에서 읽기 전용으로 조회한다
import type { Env } from "../env";
import { mapSentryIssue, type IncidentEvidence } from "./mapper";

export interface SentryClientConfig {
  token: string;
  organizationSlug: string;
  projectSlug: string;
}

export interface SentryPort {
  investigateIncident(sentryIssueUrlOrId: string): Promise<IncidentEvidence>;
}

export class SentryClient implements SentryPort {
  constructor(
    private readonly fetcher: typeof fetch,
    private readonly config: SentryClientConfig,
  ) {}

  async investigateIncident(sentryIssueUrlOrId: string): Promise<IncidentEvidence> {
    const issueId = extractIssueId(sentryIssueUrlOrId, this.config.organizationSlug);
    const scopedIssueUrl = `https://sentry.io/api/0/projects/${encodeURIComponent(this.config.organizationSlug)}/${encodeURIComponent(this.config.projectSlug)}/issues/?query=${encodeURIComponent(`id:${issueId}`)}`;
    let scopedResponse: Response;
    try {
      scopedResponse = await this.fetcher(scopedIssueUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.config.token}` },
      });
    } catch {
      throw new Error("SENTRY_READ_FAILED");
    }

    if (!scopedResponse.ok) throw new Error(errorCode(scopedResponse.status));

    let scopedIssues: unknown;
    try {
      scopedIssues = await scopedResponse.json();
    } catch {
      throw new Error("SENTRY_READ_FAILED");
    }
    if (!containsIssueId(scopedIssues, issueId)) throw new Error("SENTRY_NOT_FOUND");

    let response: Response;
    try {
      response = await this.fetcher(`https://sentry.io/api/0/issues/${issueId}/`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.config.token}` },
      });
    } catch {
      throw new Error("SENTRY_READ_FAILED");
    }

    if (!response.ok) throw new Error(errorCode(response.status));

    let issue: unknown;
    try {
      issue = await response.json();
    } catch {
      throw new Error("SENTRY_READ_FAILED");
    }
    if (!isConfiguredProject(issue, this.config)) throw new Error("SENTRY_NOT_FOUND");
    return mapSentryIssue(issue);
  }
}

function containsIssueId(value: unknown, issueId: string): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (issue) =>
        typeof issue === "object" &&
        issue !== null &&
        "id" in issue &&
        issue.id === issueId,
    )
  );
}

export function createSentryClient(
  env: Pick<Env, "SENTRY_TOKEN" | "SENTRY_ORG_SLUG" | "SENTRY_PROJECT_SLUG">,
): SentryClient {
  return new SentryClient(fetch, {
    token: env.SENTRY_TOKEN,
    organizationSlug: env.SENTRY_ORG_SLUG,
    projectSlug: env.SENTRY_PROJECT_SLUG,
  });
}

function extractIssueId(value: string, organizationSlug: string): string {
  const compact = value.trim();
  if (/^\d+$/.test(compact)) return compact;
  try {
    const url = new URL(compact);
    const match = url.pathname.match(/^\/organizations\/([^/]+)\/issues\/(\d+)/);
    if (url.hostname !== "sentry.io" || !match || match[1] !== organizationSlug) {
      throw new Error("INPUT_INVALID");
    }
    return match[2];
  } catch {
    throw new Error("INPUT_INVALID");
  }
}

function isConfiguredProject(issue: unknown, config: SentryClientConfig): boolean {
  if (typeof issue !== "object" || issue === null || !("project" in issue)) return false;
  const project = issue.project;
  if (typeof project !== "object" || project === null || !("slug" in project)) return false;
  if (project.slug !== config.projectSlug || !("organization" in project)) return false;
  const organization = project.organization;
  return (
    typeof organization === "object" &&
    organization !== null &&
    "slug" in organization &&
    organization.slug === config.organizationSlug
  );
}

function errorCode(status: number): string {
  if (status === 401) return "SENTRY_AUTH_FAILED";
  if (status === 403) return "SENTRY_FORBIDDEN";
  if (status === 404) return "SENTRY_NOT_FOUND";
  if (status === 429) return "SENTRY_RATE_LIMITED";
  return "SENTRY_READ_FAILED";
}
