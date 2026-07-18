# Notion Integration 설정

ProofOps Integration을 작업 데이터베이스에 공유한다. Integration은 `NOTION_TOKEN`, 대상 데이터베이스 ID는 `NOTION_ISSUE_DATABASE_ID`, 기술 상태 속성 이름은 `NOTION_STATUS_PROPERTY`로 등록한다. 토큰과 database ID의 원문은 설정 예시나 Git에 넣지 않는다.

## 필수 속성 확인

시작 전 대상 페이지에서 다음 속성을 확인한다.

- 제목: Notion title 속성 하나.
- `완료 조건`: rich text. 줄바꿈마다 하나의 완료 조건으로 읽는다.
- `설명`: rich text.
- `저장소`: multi-select. 값은 허용된 repository 이름과 일치해야 한다.
- `NOTION_STATUS_PROPERTY`가 가리키는 속성: status 타입.

`start_task`로 읽은 뒤 상태 속성이 업데이트되는지 확인한다. ProofOps가 쓰는 상태 이름은 `In Progress`, `In Review`, `Changes Requested`, `Blocked`, `Failed`, `Deploying`, `Verifying`, `Done`이다. 대상 status property에 이 값을 모두 미리 추가한다. 누락되거나 이름이 다른 상태는 Notion 업데이트 실패로 기록된다.

새 이슈는 제목과 본문을 만들 수 있지만, 후속 연결과 상태 갱신을 위해서도 위 status property와 `저장소` 속성을 유지한다.
