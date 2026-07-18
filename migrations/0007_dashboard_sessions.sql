-- GitHub 허용 사용자의 읽기 전용 대시보드 세션을 저장한다
CREATE TABLE dashboard_sessions (
  token_hash TEXT PRIMARY KEY,
  actor_github_user_id INTEGER NOT NULL,
  actor_github_login TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX dashboard_sessions_expires_at_idx
  ON dashboard_sessions(expires_at);
