# GitHub App 설정

ProofOps GitHub App은 조직 전체가 아니라 `landit/adapter.json`의 allowlist에 있는 저장소만 선택 설치한다. 다른 저장소를 추가하려면 먼저 adapter allowlist와 검증 workflow 경로를 코드 변경으로 검토한다.

## Repository permissions

다음 최소 권한만 부여한다.

- Pull requests: Read-only.
- Checks: Read-only.
- Actions: Read and write. `workflow_dispatch`로 고정된 검증 workflow를 시작하기 위해서다.
- Metadata: Read-only.

GitHub API가 실제로 403을 반환한 endpoint와 필요한 permission을 기록한 경우에만 권한을 넓힌다. 사전에 Contents, Issues, Deployments, Administration 권한을 추가하지 않는다.

## Webhook

Webhook URL은 배포한 Worker origin의 `/webhooks/github`이다. Content type은 JSON으로 두고, secret은 `GITHUB_WEBHOOK_SECRET`과 동일한 값으로 생성하되 값 자체를 표시하거나 저장하지 않는다.

다음 이벤트를 구독한다.

- Pull request.
- Pull request review.
- Check run.
- Workflow run.

처리기는 `pull_request`, `pull_request_review`, `check_run`, `workflow_run`만 처리하며, 서명 검증 실패는 `401`, 이미 처리된 delivery는 `202 duplicate`로 응답한다. `workflow_run`은 `workflow_dispatch`로 실행된 allowlist 저장소의 `.github/workflows/proofops-verify.yml` 완료 이벤트만 검증 결과로 반영한다.

설치 후 GitHub App ID는 `GITHUB_APP_ID`로, 다운로드한 private key는 `GITHUB_APP_PRIVATE_KEY`로 등록한다. private key는 입력 시 줄바꿈을 유지하고 repository나 문서에 저장하지 않는다.
