// GitHub upstream 인증과 명시적 MCP 클라이언트 동의를 안전하게 연결한다
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import {
  AuthorizationError,
  authorizeActor,
  parseAllowedGitHubLogins,
  type Actor,
  type GitHubProfile,
} from "./authorization";

const MCP_SCOPE = "mcp";
const STATE_TTL_SECONDS = 600;
type StateKind = "github" | "consent";

interface UpstreamState {
  request: AuthRequest;
}

interface ConsentState {
  actor: Actor;
  clientName: string;
  request: AuthRequest;
}

export async function handleAuthorize(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "POST") return handleConsent(request, env);
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (
      oauthRequest.responseType !== "code" ||
      !oauthRequest.clientId ||
      !oauthRequest.redirectUri ||
      !oauthRequest.codeChallenge ||
      oauthRequest.codeChallengeMethod !== "S256"
    ) {
      return oauthError("invalid_request", 400);
    }
    if (!hasOnlyMcpScope(oauthRequest.scope)) {
      return oauthError("invalid_scope", 400);
    }

    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) return oauthError("invalid_client", 400);
    const state = randomToken();
    await putExpiringState(env.DB, "github", state, { request: oauthRequest });

    const githubAuthorizeUrl = new URL("https://github.com/login/oauth/authorize");
    githubAuthorizeUrl.search = new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      redirect_uri: `${new URL(request.url).origin}/oauth/callback`,
      state,
    }).toString();
    return Response.redirect(githubAuthorizeUrl.toString(), 302);
  } catch {
    return oauthError("invalid_request", 400);
  }
}

export async function handleGitHubCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken || url.searchParams.has("error")) {
    return new Response("GitHub authentication failed", { status: 401 });
  }

  const state = await takeState<UpstreamState>(env.DB, "github", stateToken);
  if (!validUpstreamState(state)) {
    return new Response("Invalid OAuth state", { status: 403 });
  }

  try {
    const githubToken = await exchangeGitHubCode(code, request, env);
    const profile = await fetchGitHubProfile(githubToken);
    const actor = authorizeActor(
      profile,
      parseAllowedGitHubLogins(env.PROOFOPS_ALLOWED_GITHUB_LOGINS),
    );
    const client = await env.OAUTH_PROVIDER.lookupClient(state.request.clientId);
    if (!client) return oauthError("invalid_client", 400);

    const csrfToken = randomToken();
    const consentState: ConsentState = {
      actor,
      clientName: client.clientName ?? "Unnamed OAuth client",
      request: state.request,
    };
    await putExpiringState(env.DB, "consent", csrfToken, consentState);
    return consentPage(csrfToken, consentState);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return new Response(error.message, { status: error.status });
    }
    return new Response("GitHub authentication failed", { status: 401 });
  }
}

async function handleConsent(request: Request, env: Env): Promise<Response> {
  if (
    !request.headers
      .get("content-type")
      ?.includes("application/x-www-form-urlencoded")
  ) {
    return new Response("Invalid consent request", { status: 400 });
  }
  const form = await request.formData();
  const csrfToken = formString(form, "csrfToken");
  if (!csrfToken) return new Response("Invalid consent", { status: 403 });
  const state = await takeState<ConsentState>(env.DB, "consent", csrfToken);
  if (!validConsentState(state) || !consentBindingMatches(form, state)) {
    return new Response("Invalid consent", { status: 403 });
  }

  if (formString(form, "decision") === "deny") {
    return Response.redirect(deniedRedirect(state.request), 302);
  }
  if (formString(form, "decision") !== "approve") {
    return new Response("Invalid consent", { status: 403 });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: state.request,
    userId: `github-${state.actor.githubUserId}`,
    metadata: state.actor,
    scope: [MCP_SCOPE],
    props: state.actor,
  });
  return Response.redirect(redirectTo, 302);
}

async function exchangeGitHubCode(
  code: string,
  request: Request,
  env: Env,
): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `${new URL(request.url).origin}/oauth/callback`,
    }),
  });
  if (!response.ok) throw new Error("GitHub token exchange failed");
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("GitHub token exchange failed");
  }
  return body.access_token;
}

async function fetchGitHubProfile(accessToken: string): Promise<GitHubProfile> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "proofops",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error("GitHub profile fetch failed");
  return (await response.json()) as GitHubProfile;
}

function consentPage(csrfToken: string, state: ConsentState): Response {
  const redirectOrigin = new URL(state.request.redirectUri).origin;
  const scopes = state.request.scope.join(" ");
  const hiddenFields = [
    ["csrfToken", csrfToken],
    ["actorGithubUserId", String(state.actor.githubUserId)],
    ["clientId", state.request.clientId],
    ["redirectUri", state.request.redirectUri],
    ["scopes", scopes],
  ]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`,
    )
    .join("");
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>ProofOps 접근 승인</title></head><body><main>
<h1>ProofOps 접근 승인</h1>
<p>클라이언트: ${escapeHtml(state.clientName)}</p>
<p>Redirect origin: ${escapeHtml(redirectOrigin)}</p>
<p>요청 scope: ${escapeHtml(scopes)}</p>
<form method="post" action="/authorize">${hiddenFields}
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form></main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function consentBindingMatches(form: FormData, state: ConsentState): boolean {
  return (
    formString(form, "actorGithubUserId") === String(state.actor.githubUserId) &&
    formString(form, "clientId") === state.request.clientId &&
    formString(form, "redirectUri") === state.request.redirectUri &&
    formString(form, "scopes") === state.request.scope.join(" ") &&
    hasOnlyMcpScope(state.request.scope)
  );
}

function deniedRedirect(request: AuthRequest): string {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  if (request.state) redirect.searchParams.set("state", request.state);
  return redirect.toString();
}

async function putExpiringState(
  db: D1Database,
  kind: StateKind,
  token: string,
  value: UpstreamState | ConsentState,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_ephemeral_states (token_hash, kind, payload_json, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      await tokenHash(token),
      kind,
      JSON.stringify(value),
      Date.now() + STATE_TTL_SECONDS * 1_000,
    )
    .run();
}

async function takeState<T>(
  db: D1Database,
  kind: StateKind,
  token: string,
): Promise<T | null> {
  const now = Date.now();
  await db
    .prepare("DELETE FROM oauth_ephemeral_states WHERE expires_at < ?")
    .bind(now)
    .run();
  const row = await db
    .prepare(
      `DELETE FROM oauth_ephemeral_states
       WHERE token_hash = ? AND kind = ? AND expires_at >= ?
       RETURNING payload_json`,
    )
    .bind(await tokenHash(token), kind, now)
    .first<{ payload_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as T;
  } catch {
    return null;
  }
}

function validUpstreamState(value: UpstreamState | null): value is UpstreamState {
  return Boolean(value?.request && hasOnlyMcpScope(value.request.scope));
}

function validConsentState(value: ConsentState | null): value is ConsentState {
  return Boolean(
      value &&
      value.actor &&
      value.request &&
      hasOnlyMcpScope(value.request.scope),
  );
}

function hasOnlyMcpScope(scopes: string[]): boolean {
  return scopes.length === 1 && scopes[0] === MCP_SCOPE;
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

function formString(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function oauthError(
  error: "invalid_client" | "invalid_request" | "invalid_scope",
  status: number,
): Response {
  return Response.json({ error }, { status });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
