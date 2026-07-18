// ProofOps Worker의 HTTP 및 MCP 요청 진입점
import { Hono } from "hono";
import type { Env } from "./env";
import { registerHealthRoute } from "./routes/health";

const app = new Hono<{ Bindings: Env }>();
registerHealthRoute(app);

export default app;
