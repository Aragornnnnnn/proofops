// GitHub App Webhook 엔드포인트를 Worker 라우터에 등록한다
import type { Hono } from "hono";
import type { Env } from "../env";
import { createGitHubClient } from "../github/app-client";
import { handleGitHubWebhook } from "../github/webhook";
import { createNotionClient } from "../notion/client";

export function registerGitHubWebhookRoute(app: Hono<{ Bindings: Env }>): void {
  app.post("/webhooks/github", (context) =>
    handleGitHubWebhook(context.req.raw, {
      db: context.env.DB,
      webhookSecret: context.env.GITHUB_WEBHOOK_SECRET,
      github: createGitHubClient(context.env),
      notion: createNotionClient(context.env),
    }),
  );
}
