// ProofOps 작업 도구를 Durable Object 기반 MCP 서버로 제공한다
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { authorizeOAuthProps, type Actor } from "../auth/authorization";
import type { Env } from "../env";
import { createProofOpsTools, registerProofOpsTools } from "./tools";

export class ProofOpsMcp extends McpAgent<Env, unknown, Actor> {
  server = new McpServer({ name: "proofops", version: "1.0.0" });

  async init(): Promise<void> {
    const actor = authorizeOAuthProps(
      this.props,
      this.env.PROOFOPS_ALLOWED_GITHUB_LOGINS,
    );
    registerProofOpsTools(this.server, createProofOpsTools(this.env, actor));
  }
}
