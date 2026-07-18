-- 인증 행위자 감사와 단일 사용 OAuth 상태를 저장한다
ALTER TABLE progress_notes ADD COLUMN actor_github_user_id INTEGER;

CREATE TABLE oauth_ephemeral_states (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('github', 'consent')),
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX oauth_ephemeral_states_expires_at_idx
  ON oauth_ephemeral_states(expires_at);

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  actor_github_user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_events_actor_created_at_idx
  ON audit_events(actor_github_user_id, created_at);
