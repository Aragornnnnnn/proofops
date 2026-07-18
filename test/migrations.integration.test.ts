// 실제 D1 마이그레이션 파일의 순차 적용 가능 여부를 검증한다
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import initialMigration from "../migrations/0001_initial.sql?raw";
import linkedAtMigration from "../migrations/0002_pull_request_linked_at.sql?raw";
import verificationRequestsMigration from "../migrations/0003_verification_requests.sql?raw";
import actorAuditMigration from "../migrations/0004_actor_audit.sql?raw";
import reviewSecurityMigration from "../migrations/0005_review_security.sql?raw";
import operationLifecycleMigration from "../migrations/0006_operation_lifecycle.sql?raw";
import dashboardSessionsMigration from "../migrations/0007_dashboard_sessions.sql?raw";

const migrationFiles = [
  initialMigration,
  linkedAtMigration,
  verificationRequestsMigration,
  actorAuditMigration,
  reviewSecurityMigration,
  operationLifecycleMigration,
  dashboardSessionsMigration,
];

async function resetDatabase(): Promise<void> {
  await env.DB.exec(`
    DROP TABLE IF EXISTS progress_notes;
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS verification_runs;
    DROP TABLE IF EXISTS verification_requests;
    DROP TABLE IF EXISTS oauth_ephemeral_states;
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS mcp_sessions;
    DROP TABLE IF EXISTS dashboard_sessions;
    DROP TABLE IF EXISTS pull_requests;
    DROP TABLE IF EXISTS tasks;
  `);
}

function statements(migration: string): string[] {
  return migration
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("D1 마이그레이션 체인", () => {
  afterEach(resetDatabase);

  it("빈 데이터베이스에 순서대로 적용해 linked_at 열을 한 번만 만든다", async () => {
    await resetDatabase();

    for (const migration of migrationFiles) {
      for (const statement of statements(migration)) {
        await env.DB.prepare(statement).run();
      }
    }

    const columns = await env.DB.prepare("PRAGMA table_info(pull_requests)").all<{
      name: string;
    }>();
    expect(columns.results.filter((column) => column.name === "linked_at")).toHaveLength(1);

    const verificationColumns = await env.DB
      .prepare("PRAGMA table_info(verification_runs)")
      .all<{ name: string }>();
    expect(
      verificationColumns.results.filter((column) => column.name === "commit_sha"),
    ).toHaveLength(1);
    expect(
      verificationColumns.results.filter((column) => column.name === "request_id"),
    ).toHaveLength(1);

    const requestTable = await env.DB
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verification_requests'",
      )
      .first<{ name: string }>();
    expect(requestTable).toEqual({ name: "verification_requests" });

    const progressColumns = await env.DB
      .prepare("PRAGMA table_info(progress_notes)")
      .all<{ name: string }>();
    expect(
      progressColumns.results.filter(
        (column) => column.name === "actor_github_user_id",
      ),
    ).toHaveLength(1);

    const oauthStateTable = await env.DB
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_ephemeral_states'",
      )
      .first<{ name: string }>();
    expect(oauthStateTable).toEqual({ name: "oauth_ephemeral_states" });

    const auditTable = await env.DB
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'",
      )
      .first<{ name: string }>();
    expect(auditTable).toEqual({ name: "audit_events" });

    const sessionTable = await env.DB
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_sessions'",
      )
      .first<{ name: string }>();
    expect(sessionTable).toEqual({ name: "mcp_sessions" });

    const dashboardSessionTable = await env.DB
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_sessions'",
      )
      .first<{ name: string }>();
    expect(dashboardSessionTable).toEqual({ name: "dashboard_sessions" });

    const auditColumns = await env.DB
      .prepare("PRAGMA table_info(audit_events)")
      .all<{ name: string }>();
    expect(auditColumns.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "status",
        "idempotency_key",
        "updated_at",
        "error_code",
        "operation_id",
        "input_hash",
      ]),
    );
  });
});
