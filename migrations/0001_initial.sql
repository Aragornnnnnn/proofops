-- Notion 작업과 GitHub 및 운영 증거의 최소 연결 정보를 저장한다
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  notion_page_id TEXT NOT NULL UNIQUE,
  notion_url TEXT NOT NULL,
  title TEXT NOT NULL,
  technical_status TEXT NOT NULL,
  expected_repositories TEXT NOT NULL DEFAULT '[]',
  last_sync_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  state TEXT NOT NULL,
  review_state TEXT NOT NULL,
  ci_state TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repository, pr_number)
);

CREATE TABLE verification_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  repository TEXT NOT NULL,
  environment TEXT NOT NULL,
  workflow_run_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(provider, delivery_id)
);

CREATE TABLE progress_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_url TEXT,
  created_at TEXT NOT NULL
);
