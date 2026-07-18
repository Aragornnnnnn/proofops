-- MCP 세션 소유권과 외부 mutation 작업 상태를 영속적으로 추적한다
ALTER TABLE audit_events ADD COLUMN status TEXT NOT NULL DEFAULT 'succeeded';
ALTER TABLE audit_events ADD COLUMN idempotency_key TEXT;
ALTER TABLE audit_events ADD COLUMN updated_at TEXT;
ALTER TABLE audit_events ADD COLUMN error_code TEXT;

CREATE UNIQUE INDEX audit_events_idempotency_key_idx
  ON audit_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE mcp_sessions (
  session_id TEXT PRIMARY KEY,
  actor_github_user_id INTEGER NOT NULL,
  actor_github_login TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX mcp_sessions_expires_at_idx ON mcp_sessions(expires_at);
