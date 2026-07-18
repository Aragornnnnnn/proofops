// ProofOps Worker의 HTTP 및 MCP 요청 진입점
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { handleMcpAccess } from "./auth/mcp-access";
import { handleAuthorize, handleGitHubCallback } from "./auth/oauth-flow";
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
    fetch: (request, env, context) =>
      handleMcpAccess(request, env, context.props, async () =>
        app.fetch(request, env, context),
      ),
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
