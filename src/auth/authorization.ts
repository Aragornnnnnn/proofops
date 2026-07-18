// GitHub OAuth 프로필을 팀 allowlist와 대조해 인증된 행위자로 변환한다
export interface Actor extends Record<string, unknown> {
  githubUserId: number;
  githubLogin: string;
}

export interface GitHubProfile {
  id?: unknown;
  login?: unknown;
}

export class AuthorizationError extends Error {
  constructor(readonly status: 401 | 403) {
    super(status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN");
  }
}

export function parseAllowedGitHubLogins(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeLogin).filter(Boolean))];
}

export function authorizeActor(
  profile: GitHubProfile,
  allowedLogins: string[],
): Actor {
  if (
    typeof profile.id !== "number" ||
    !Number.isSafeInteger(profile.id) ||
    profile.id <= 0 ||
    typeof profile.login !== "string" ||
    !normalizeLogin(profile.login)
  ) {
    throw new AuthorizationError(401);
  }

  const githubLogin = normalizeLogin(profile.login);
  const normalizedAllowedLogins = new Set(
    allowedLogins.map(normalizeLogin).filter(Boolean),
  );
  if (!normalizedAllowedLogins.has(githubLogin)) throw new AuthorizationError(403);

  return { githubUserId: profile.id, githubLogin };
}

export function authorizeOAuthProps(props: unknown, allowedLogins: string): Actor {
  const value = isRecord(props) ? props : {};
  return authorizeActor(
    { id: value.githubUserId, login: value.githubLogin },
    parseAllowedGitHubLogins(allowedLogins),
  );
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
