# Preview 검증 기록

검증 시각은 2026-07-18 KST이다. 이 기록은 로컬에서 실제 실행한 결과만 담는다. preview 배포, 원격 D1 변경, OAuth 로그인, Notion·GitHub·Sentry 호출, Webhook 재전송과 Landit 운영 환경 접근은 수행하지 않았다.

## 로컬 검증 결과

| 검사 | 실제 명령 | 결과 |
| --- | --- | --- |
| 타입 검사 | `npm run typecheck` | 성공. `tsc --noEmit` 종료 코드 0. |
| 전체 테스트 | `npm test -- --run` | 성공. Vitest 14개 파일, 164개 테스트 통과. MCP SDK 의존성 source map 경고는 있었으나 테스트 실패는 없었다. |
| 클라이언트 문서 검사 | `npm run check:client-docs` | 성공. 종료 코드 0. |
| 로컬 D1 마이그레이션 | `npx wrangler d1 migrations apply proofops-local --local` | 성공. 로컬 `.wrangler/state/v3/d1`에 `0002_pull_request_linked_at.sql`부터 `0006_operation_lifecycle.sql`까지 적용되었다. |
| 작업 트리 공백 검사 | `git diff --check` | 성공. 종료 코드 0. |
| Worker 번들 dry-run | `npx wrangler deploy --dry-run` | 실패. 종료 코드 1. `node_modules/mimetext/node_modules/mime-types/index.js`의 Node 내장 모듈 `path`를 해석하지 못했다. Wrangler는 `nodejs_compat` compatibility flag를 요구한다. |

처음 sandbox에서 실행한 Worker 테스트와 로컬 D1 마이그레이션은 Wrangler가 loopback 포트와 사용자 Wrangler 로그 경로에 접근하지 못해 `EPERM`으로 실패했다. 동일한 로컬 명령을 권한이 허용된 환경에서 재실행한 결과는 위 표와 같다.

## 수행하지 않은 preview 세로 흐름

다음은 자격 증명과 리소스 식별자가 제공되지 않았고, 이 검증의 권한 범위 밖이어서 실행하지 않았다.

- `proofops-preview` 원격 D1 마이그레이션과 preview Worker 배포.
- Codex 및 Claude Code의 GitHub OAuth 로그인과 동일 task ID에 대한 MCP 도구 호출.
- Landit Notion 테스트 이슈, GitHub 테스트 PR, PR·review·check·workflow Webhook 재전송과 상태 수렴 확인.
- GitHub Actions의 AWS OIDC 읽기 전용 workflow 실행 및 `proofops-verification` 아티팩트 확인.
- Sentry `investigate_incident` 및 `create_notion_issue` 호출.
- Cloudflare 로그와 preview D1 표본의 민감정보 비저장 확인.

따라서 preview URL, 실행 시간, 사용자별 클라이언트 결과, 실제 task ID, PR SHA, Notion 상태 전이, 인수인계, Cloudflare 로그/D1 표본은 확인된 사실이 아니다. 실제 preview 또는 운영 워크플로가 통과했다고 주장하지 않는다.

## 배포 및 실제 검증 blocker

1. `npx wrangler deploy --dry-run`이 `path` 미해결로 실패한다. preview 배포 전에 Worker 런타임 호환성 문제를 수정하고 dry-run을 다시 통과시켜야 한다.
2. 현재 `wrangler.jsonc`은 로컬 placeholder D1/KV ID만 포함한다. preview D1 database ID, OAuth KV namespace ID와 배포할 Worker 이름 또는 환경 설정이 필요하다.
3. GitHub OAuth, GitHub App, Notion, Sentry, Webhook 서명 검증에 필요한 secret과 테스트용 외부 리소스가 제공되지 않았다.
4. 위 blocker가 해소된 뒤에만 실제 preview 배포, 두 MCP 클라이언트 OAuth, Webhook 재전송, workflow artifact, 상태 전이 및 로그/D1 민감정보 검사를 수행할 수 있다.
