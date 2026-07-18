-- 검증 요청 문맥과 대상 커밋을 Webhook 결과에 내구성 있게 결합한다
CREATE TABLE verification_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  repository TEXT NOT NULL,
  environment TEXT NOT NULL,
  target_commit_sha TEXT NOT NULL,
  trusted_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  workflow_run_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE verification_runs ADD COLUMN request_id TEXT REFERENCES verification_requests(request_id);
ALTER TABLE verification_runs ADD COLUMN commit_sha TEXT NOT NULL DEFAULT '';
