// 실제 D1 마이그레이션 파일의 순차 적용 가능 여부를 검증한다
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import initialMigration from "../migrations/0001_initial.sql?raw";
import linkedAtMigration from "../migrations/0002_pull_request_linked_at.sql?raw";

const migrationFiles = [initialMigration, linkedAtMigration];

async function resetDatabase(): Promise<void> {
  await env.DB.exec(`
    DROP TABLE IF EXISTS progress_notes;
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS verification_runs;
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
  });
});
