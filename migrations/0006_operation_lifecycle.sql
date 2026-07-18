-- 호출자 operation ID와 외부 효과 단계 및 입력 해시를 감사 이벤트에 저장한다
ALTER TABLE audit_events ADD COLUMN operation_id TEXT;
ALTER TABLE audit_events ADD COLUMN input_hash TEXT;

CREATE UNIQUE INDEX audit_events_operation_id_idx
  ON audit_events(operation_id)
  WHERE operation_id IS NOT NULL;
