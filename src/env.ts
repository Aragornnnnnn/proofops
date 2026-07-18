// ProofOps Worker의 바인딩과 비밀값 형식을 정의하는 타입
export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  ENVIRONMENT: "local" | "preview" | "production";
  NOTION_TOKEN: string;
  NOTION_ISSUE_DATABASE_ID: string;
  NOTION_STATUS_PROPERTY: string;
}

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ENVIRONMENT: "local" | "preview" | "production";
      NOTION_TOKEN: string;
      NOTION_ISSUE_DATABASE_ID: string;
      NOTION_STATUS_PROPERTY: string;
    }
  }
}
