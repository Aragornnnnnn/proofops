// 서비스 생존 상태를 노출하는 HTTP 라우트
import type { Hono } from "hono";
import type { Env } from "../env";

export function registerHealthRoute(app: Hono<{ Bindings: Env }>): void {
  app.get("/health", (context) =>
    context.json({
      service: "proofops",
      status: "ok",
      environment: context.env.ENVIRONMENT,
    }),
  );
}
