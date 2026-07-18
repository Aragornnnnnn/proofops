# 운영 절차

모든 D1 조회는 영향 범위를 먼저 좁히고 `--remote` 대상 이름을 preview 또는 production 중 실제 Worker binding과 일치시키고 실행한다. 조회 결과에 외부 token이나 private key를 남기지 않는다.

## GitHub Webhook 재전송

GitHub App의 Advanced webhook deliveries에서 실패한 delivery를 열어 응답 코드와 event를 확인한 뒤 Redeliver를 사용한다. ProofOps는 처리 도중 실패하면 delivery 기록을 제거하고 `502 retry`를 반환하므로 같은 delivery를 재전송할 수 있다. 이미 `202 duplicate`를 받은 성공 delivery는 다시 처리하지 않는다. 재전송 전에 서명 secret, allowlist 저장소, `.github/workflows/proofops-verify.yml` 경로를 확인한다.

## Notion sync 재시도

Notion 상태 갱신 실패는 task의 `last_sync_error`에 `NOTION_SYNC_FAILED`로 저장된다. Integration 공유, database ID, status property 이름과 status option을 고친 뒤, 연결된 작업의 MCP `get_task_status`를 호출해 현재 GitHub 상태를 재조정한다. 다음 지원 GitHub Webhook도 같은 작업의 Notion 동기화를 다시 시도한다.

```bash
npx wrangler d1 execute proofops-preview --remote --command "SELECT id, notion_page_id, technical_status, last_sync_error, updated_at FROM tasks WHERE id = 'TASK_ID';"
```

`TASK_ID`는 조회 대상 task ID로만 바꾼다. 해결 뒤에는 같은 SELECT로 `last_sync_error`가 `NULL`인지 확인한다.

## D1 점검

Webhook delivery와 검증 요청을 확인할 때는 필요한 열만 조회한다.

```bash
npx wrangler d1 execute proofops-preview --remote --command "SELECT provider, delivery_id, received_at FROM webhook_deliveries WHERE provider = 'github' ORDER BY received_at DESC LIMIT 20;"
npx wrangler d1 execute proofops-preview --remote --command "SELECT request_id, task_id, repository, environment, status, updated_at FROM verification_requests ORDER BY updated_at DESC LIMIT 20;"
```

## OAuth 사용자 제거

사용자 ID는 GitHub numeric ID를 접두한 `github-<numeric-id>` 형식이다. 현재 public route에는 운영자 grant-revocation endpoint가 없으므로 D1이나 KV 키를 직접 삭제하지 않는다. 접근 통제된 일회성 운영 handler에서 `env.OAUTH_PROVIDER.listUserGrants(userId)`로 grant를 열거하고, 각 `grant.id`에 `env.OAUTH_PROVIDER.revokeGrant(grant.id, userId)`를 호출한다. handler와 로그는 실행 직후 제거하고, 다시 로그인해 새 grant가 생성되는지 확인한다.

## Secret 교체

새 값을 만든 뒤 해당 binding만 다시 입력하고 Worker를 재배포한다.

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler deploy --name proofops-preview
```

Webhook secret을 바꿀 때는 GitHub App webhook secret도 같은 값으로 바꾸고, 즉시 테스트 delivery를 보낸다. GitHub OAuth client secret, Notion token, GitHub App private key, Sentry token도 같은 절차로 교체한다. 유출 의심 시에는 해당 공급자에서 먼저 폐기한 뒤 새 secret을 등록하고, OAuth 사용자 grant도 필요한 범위에서 revoke한다.
