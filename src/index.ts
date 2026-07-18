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
app.get("/", (context) =>
  context.html(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ProofOps</title>
  </head>
  <body>
    <main>
      <p>Landit 운영 자동화</p>
      <h1>ProofOps</h1>
      <p>GitHub 이벤트 연결됨</p>
      <p>Notion 작업과 배포 검증 연결을 준비하고 있습니다.</p>
      <a href="/health">서비스 상태 확인</a>
    </main>
  </body>
</html>`),
);
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
