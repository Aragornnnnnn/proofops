// ProofOps Worker의 HTTP 및 MCP 요청 진입점
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { handleAuthorize, handleGitHubCallback } from "./auth/oauth-flow";
import { AuthorizationError, authorizeOAuthProps } from "./auth/authorization";
import type { Env } from "./env";
import { ProofOpsMcp } from "./mcp/agent";
import { registerGitHubWebhookRoute } from "./routes/github-webhook";
import { registerHealthRoute } from "./routes/health";

const app = new Hono<{ Bindings: Env }>();
registerHealthRoute(app);
registerGitHubWebhookRoute(app);
app.all("/authorize", (context) => handleAuthorize(context.req.raw, context.env));
app.get("/oauth/callback", (context) =>
  handleGitHubCallback(context.req.raw, context.env),
);
const mcp = ProofOpsMcp.serve("/mcp");

app.all("/mcp", (context) =>
  mcp.fetch(
    context.req.raw,
    context.env,
    context.executionCtx as unknown as ExecutionContext<unknown>,
  ),
);

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    fetch: (request, env, context) => {
      try {
        authorizeOAuthProps(context.props, env.PROOFOPS_ALLOWED_GITHUB_LOGINS);
        return app.fetch(request, env, context);
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return new Response(error.message, { status: error.status });
        }
        throw error;
      }
    },
  },
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp"],
  allowPlainPKCE: false,
});

export default oauthProvider;
export { ProofOpsMcp };
