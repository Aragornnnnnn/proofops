# ProofOps 시작하기

로컬 Worker는 `http://127.0.0.1:8787/mcp`에서 MCP를 제공한다. [Codex 설정 예시](../clients/codex/config.toml.example) 또는 [Claude Code 설정 예시](../clients/claude/.mcp.json.example)를 각 클라이언트의 MCP 설정에 복사한 뒤 `npm run dev`를 실행한다. 처음 연결하면 MCP OAuth 동적 클라이언트 등록, GitHub 로그인, allowlist 검사, 접근 승인 순서가 진행된다.

## Cloudflare preview 준비

아래 명령은 preview용 D1 데이터베이스를 만들고, 현재 `wrangler.jsonc`의 `DB` binding이 출력된 `database_id`를 사용하도록 바꾼 뒤 실행한다. `OAUTH_KV`도 Worker OAuth Provider가 요구하는 별도 KV namespace다.

```bash
npx wrangler login
npx wrangler d1 create proofops-preview
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 migrations apply proofops-preview --remote
```

`wrangler.jsonc`에서 `database_name`을 `proofops-preview`로, `database_id`와 `OAUTH_KV`의 `id`를 각 생성 명령 출력값으로 갱신한다. 그 다음 다음 명령으로 preview Worker를 배포한다.

```bash
npx wrangler deploy --name proofops-preview
```

## Secret 등록과 OAuth callback

각 명령은 표준 입력으로 값을 받으므로 값이나 키 파일을 셸 기록·문서·설정 예시에 넣지 않는다.

```bash
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put PROOFOPS_ALLOWED_GITHUB_LOGINS
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_ISSUE_DATABASE_ID
npx wrangler secret put NOTION_STATUS_PROPERTY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put SENTRY_TOKEN
```

GitHub OAuth App의 Authorization callback URL에는 배포 명령이 출력한 Worker URL에 `/oauth/callback`을 붙인 값을 등록한다. 예를 들어 Worker URL이 `https://proofops-preview.example.workers.dev`이면 callback은 `https://proofops-preview.example.workers.dev/oauth/callback`이다. MCP endpoint는 같은 origin의 `/mcp`이며, 현재 OAuth discovery는 `/authorize`, `/oauth/token`, `/oauth/register`를 제공하고 scope는 `mcp`만 허용한다.

배포 뒤 다음 명령으로 service origin을 확인하고, Codex·Claude Code 예시의 URL을 해당 origin의 `/mcp`로 바꾼다.

```bash
npx wrangler deployments list --name proofops-preview
```

`/health`가 `status: "ok"`를 반환하는지 확인한 뒤, 세 명이 각자 클라이언트에서 연결하고 GitHub 로그인·승인을 완료한 다음 도구 목록을 새로고침한다.
