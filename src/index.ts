// ProofOps Worker의 HTTP 및 MCP 요청 진입점
import { Hono } from "hono";
import type { Env } from "./env";
import { ProofOpsMcp } from "./mcp/agent";
import { registerGitHubWebhookRoute } from "./routes/github-webhook";
import { registerHealthRoute } from "./routes/health";

const app = new Hono<{ Bindings: Env }>();
registerHealthRoute(app);
registerGitHubWebhookRoute(app);
const mcp = ProofOpsMcp.serve("/mcp");

app.all("/mcp", (context) =>
  mcp.fetch(
    context.req.raw,
    context.env,
    context.executionCtx as unknown as ExecutionContext<unknown>,
  ),
);

export default app;
export { ProofOpsMcp };
