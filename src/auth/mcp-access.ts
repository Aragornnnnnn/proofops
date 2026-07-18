// MCP bearer scope와 세션 소유자를 요청 실행 전에 검증한다
import type { Env } from "../env";
import {
  AuthorizationError,
  authorizeOAuthProps,
  type Actor,
} from "./authorization";

const MCP_SCOPE = "mcp";

export async function handleMcpAccess(
  request: Request,
  env: Env,
  oauthProps: unknown,
  next: () => Promise<Response>,
): Promise<Response> {
  try {
    const tokenValue = bearerToken(request);
    const token = await env.OAUTH_PROVIDER.unwrapToken<Actor>(tokenValue);
    if (!token || !token.scope.includes(MCP_SCOPE)) {
      throw new AuthorizationError(403);
    }

    const actor = authorizeOAuthProps(
      token.grant.props,
      env.PROOFOPS_ALLOWED_GITHUB_LOGINS,
    );
    const contextActor = authorizeOAuthProps(
      oauthProps,
      env.PROOFOPS_ALLOWED_GITHUB_LOGINS,
    );
    if (!sameActor(actor, contextActor)) throw new AuthorizationError(403);

    const now = Math.floor(Date.now() / 1_000);
    await env.DB.prepare("DELETE FROM mcp_sessions WHERE expires_at <= ?")
      .bind(now)
      .run();

    const requestSessionId = request.headers.get("mcp-session-id");
    if (requestSessionId) {
      const owner = await sessionOwner(env.DB, requestSessionId);
      if (!owner || !sameActor(actor, owner)) throw new AuthorizationError(403);
    }

    const response = await next();
    const responseSessionId = response.headers.get("mcp-session-id");
    if (!requestSessionId && responseSessionId) {
      await env.DB
        .prepare(
          `INSERT OR IGNORE INTO mcp_sessions (
             session_id, actor_github_user_id, actor_github_login, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          responseSessionId,
          actor.githubUserId,
          actor.githubLogin,
          token.expiresAt,
          now,
        )
        .run();
      const owner = await sessionOwner(env.DB, responseSessionId);
      if (!owner || !sameActor(actor, owner)) {
        await response.body?.cancel();
        throw new AuthorizationError(403);
      }
    }

    if (request.method === "DELETE" && requestSessionId && response.ok) {
      await env.DB.prepare("DELETE FROM mcp_sessions WHERE session_id = ?")
        .bind(requestSessionId)
        .run();
    }
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) throw new AuthorizationError(401);
  return match[1];
}

async function sessionOwner(
  db: D1Database,
  sessionId: string,
): Promise<Actor | null> {
  const row = await db
    .prepare(
      `SELECT actor_github_user_id, actor_github_login
       FROM mcp_sessions WHERE session_id = ?`,
    )
    .bind(sessionId)
    .first<{
      actor_github_user_id: number;
      actor_github_login: string;
    }>();
  return row
    ? {
        githubUserId: row.actor_github_user_id,
        githubLogin: row.actor_github_login,
      }
    : null;
}

function sameActor(left: Actor, right: Actor): boolean {
  return (
    left.githubUserId === right.githubUserId &&
    left.githubLogin === right.githubLogin
  );
}
