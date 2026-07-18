-- PR 연결 순서를 상태 관측 시간과 분리해 보존한다
ALTER TABLE pull_requests ADD COLUMN linked_at TEXT NOT NULL DEFAULT '';
UPDATE pull_requests SET linked_at = updated_at WHERE linked_at = '';
