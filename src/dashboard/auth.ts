// 허용된 GitHub 사용자에게 읽기 전용 대시보드 세션을 발급하고 검증한다
import type { Env } from "../env";
import {
  AuthorizationError,
  authorizeActor,
  parseAllowedGitHubLogins,
  type Actor,
} from "../auth/authorization";
import { exchangeGitHubCode, fetchGitHubProfile } from "../auth/oauth-flow";

const COOKIE_NAME = "proofops_dashboard_session";
const STATE_TTL_MS = 10 * 60 * 1_000;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

interface DashboardState {
  flow: "dashboard";
}

export async function beginDashboardLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  const state = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB
      .prepare("DELETE FROM oauth_ephemeral_states WHERE expires_at < ?")
      .bind(now),
    env.DB
      .prepare(
        `INSERT INTO oauth_ephemeral_states (token_hash, kind, payload_json, expires_at)
         VALUES (?, 'github', ?, ?)`,
      )
      .bind(
        await tokenHash(state),
        JSON.stringify({ flow: "dashboard" } satisfies DashboardState),
        now + STATE_TTL_MS,
      ),
  ]);

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: `${new URL(request.url).origin}/oauth/callback`,
    state,
  }).toString();
  return Response.redirect(authorizeUrl.toString(), 302);
}

export async function handleDashboardCallback(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const stateToken = url.searchParams.get("state");
  if (!stateToken) return null;
  const hash = await tokenHash(stateToken);
  const now = Date.now();
  const row = await env.DB
    .prepare(
      `SELECT payload_json FROM oauth_ephemeral_states
       WHERE token_hash = ? AND kind = 'github' AND expires_at >= ?`,
    )
    .bind(hash, now)
    .first<{ payload_json: string }>();
  if (!isDashboardState(row?.payload_json)) return null;

  const consumed = await env.DB
    .prepare(
      `DELETE FROM oauth_ephemeral_states
       WHERE token_hash = ? AND kind = 'github' AND expires_at >= ?
       RETURNING token_hash`,
    )
    .bind(hash, now)
    .first<{ token_hash: string }>();
  if (!consumed) return new Response("Invalid OAuth state", { status: 403 });
  if (url.searchParams.has("error")) return Response.redirect(`${url.origin}/`, 302);

  const code = url.searchParams.get("code");
  if (!code) return new Response("Invalid OAuth callback", { status: 400 });
  try {
    const accessToken = await exchangeGitHubCode(code, request, env);
    const profile = await fetchGitHubProfile(accessToken);
    const actor = authorizeActor(
      profile,
      parseAllowedGitHubLogins(env.PROOFOPS_ALLOWED_GITHUB_LOGINS),
    );
    const sessionToken = randomToken();
    const expiresAt = now + SESSION_TTL_SECONDS * 1_000;
    await env.DB.batch([
      env.DB
        .prepare("DELETE FROM dashboard_sessions WHERE expires_at < ?")
        .bind(now),
      env.DB
        .prepare(
          `INSERT INTO dashboard_sessions (
            token_hash, actor_github_user_id, actor_github_login, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          await tokenHash(sessionToken),
          actor.githubUserId,
          actor.githubLogin,
          expiresAt,
          now,
        ),
    ]);
    return new Response(null, {
      status: 302,
      headers: {
        location: `${url.origin}/dashboard`,
        "set-cookie": sessionCookie(sessionToken, SESSION_TTL_SECONDS),
      },
    });
  } catch (error) {
    return new Response(
      error instanceof AuthorizationError ? "GitHub account is not allowed" : "GitHub login failed",
      { status: error instanceof AuthorizationError ? error.status : 502 },
    );
  }
}

export async function requireDashboardActor(
  request: Request,
  env: Env,
): Promise<Actor | null> {
  const token = cookieValue(request.headers.get("cookie"), COOKIE_NAME);
  if (!token) return null;
  const now = Date.now();
  await env.DB
    .prepare("DELETE FROM dashboard_sessions WHERE expires_at < ?")
    .bind(now)
    .run();
  const row = await env.DB
    .prepare(
      `SELECT actor_github_user_id, actor_github_login
       FROM dashboard_sessions WHERE token_hash = ? AND expires_at >= ?`,
    )
    .bind(await tokenHash(token), now)
    .first<{ actor_github_user_id: number; actor_github_login: string }>();
  return row
    ? {
        githubUserId: row.actor_github_user_id,
        githubLogin: row.actor_github_login,
      }
    : null;
}

export async function logoutDashboard(request: Request, env: Env): Promise<Response> {
  const token = cookieValue(request.headers.get("cookie"), COOKIE_NAME);
  if (token) {
    await env.DB
      .prepare("DELETE FROM dashboard_sessions WHERE token_hash = ?")
      .bind(await tokenHash(token))
      .run();
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: `${new URL(request.url).origin}/`,
      "set-cookie": sessionCookie("", 0),
    },
  });
}

function isDashboardState(payload: string | undefined): boolean {
  if (!payload) return false;
  try {
    return (JSON.parse(payload) as Partial<DashboardState>).flow === "dashboard";
  } catch {
    return false;
  }
}

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function cookieValue(header: string | null, name: string): string | null {
  const item = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
