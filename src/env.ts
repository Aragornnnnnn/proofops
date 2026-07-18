// ProofOps Worker의 바인딩과 비밀값 형식을 정의하는 타입
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  PROOFOPS_ALLOWED_GITHUB_LOGINS: string;
  ENVIRONMENT: "local" | "preview" | "production";
  NOTION_TOKEN: string;
  NOTION_ISSUE_DATABASE_ID: string;
  NOTION_STATUS_PROPERTY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  SENTRY_TOKEN: string;
  SENTRY_ORG_SLUG: string;
  SENTRY_PROJECT_SLUG: string;
}

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      MCP_OBJECT: DurableObjectNamespace;
      OAUTH_KV: KVNamespace;
      OAUTH_PROVIDER: OAuthHelpers;
      GITHUB_OAUTH_CLIENT_ID: string;
      GITHUB_OAUTH_CLIENT_SECRET: string;
      PROOFOPS_ALLOWED_GITHUB_LOGINS: string;
      ENVIRONMENT: "local" | "preview" | "production";
      NOTION_TOKEN: string;
      NOTION_ISSUE_DATABASE_ID: string;
      NOTION_STATUS_PROPERTY: string;
      GITHUB_APP_ID: string;
      GITHUB_APP_PRIVATE_KEY: string;
      GITHUB_WEBHOOK_SECRET: string;
      SENTRY_TOKEN: string;
      SENTRY_ORG_SLUG: string;
      SENTRY_PROJECT_SLUG: string;
    }
  }
}
