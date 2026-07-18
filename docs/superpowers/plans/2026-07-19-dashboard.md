# ProofOps Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 허용된 GitHub 사용자만 작업, PR, 리뷰/CI, 운영 검증 상태를 조회할 수 있는 읽기 전용 대시보드를 배포한다.

**Architecture:** 기존 Cloudflare Worker 안에 GitHub OAuth 로그인, D1 기반 불투명 세션, 서버 렌더링 대시보드를 추가한다. 기존 MCP OAuth callback을 공유하되 dashboard state를 먼저 판별하고, 인증되지 않은 요청에는 운영 데이터를 반환하지 않는다.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1, Vitest.

## Global Constraints

- 대시보드는 읽기 전용이다.
- `PROOFOPS_ALLOWED_GITHUB_LOGINS`에 포함된 GitHub 사용자만 접근한다.
- GitHub access token은 저장하지 않는다.
- 기존 MCP OAuth 흐름과 `/webhooks/github` 동작을 보존한다.

---

### Task 1: 대시보드 인증과 세션

**Files:**
- Create: `src/dashboard/auth.ts`
- Create: `migrations/0007_dashboard_sessions.sql`
- Modify: `src/index.ts`
- Modify: `test/worker.integration.test.ts`
- Modify: `test/migrations.integration.test.ts`

**Interfaces:**
- Produces: `beginDashboardLogin(request, env)`, `handleDashboardCallback(request, env)`, `requireDashboardActor(request, env)`, `logoutDashboard(request, env)`.

- [x] **Step 1: Write the failing tests**

로그인 redirect, 허용 사용자 callback cookie, 비허용 사용자 거절, 세션 없는 dashboard redirect, logout 무효화를 통합 테스트에 추가한다.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- test/worker.integration.test.ts`

Expected: `/dashboard/login` 또는 `/dashboard`가 아직 없어 FAIL.

- [x] **Step 3: Write minimal implementation**

GitHub OAuth state는 기존 `oauth_ephemeral_states`에 `github` kind와 dashboard payload로 10분간 저장한다. callback에서 dashboard payload를 원자적으로 소비하고 GitHub profile을 allowlist로 검증한 뒤, 7일 수명의 임의 토큰 hash만 `dashboard_sessions`에 저장한다. 쿠키는 `HttpOnly; Secure; SameSite=Lax; Path=/`로 설정한다.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- test/worker.integration.test.ts`

Expected: PASS.

### Task 2: 읽기 전용 상태 화면

**Files:**
- Create: `src/dashboard/data.ts`
- Create: `src/dashboard/page.ts`
- Modify: `src/index.ts`
- Modify: `test/worker.integration.test.ts`

**Interfaces:**
- Produces: `loadDashboard(db): Promise<DashboardData>`, `renderDashboard(actor, data): Response`, `renderLanding(): Response`.

- [x] **Step 1: Write the failing test**

인증 세션으로 `/dashboard`를 요청했을 때 작업 제목, Notion 링크, PR 상태, review/CI 상태, 최신 운영 검증을 HTML escape 후 표시하는 테스트를 추가한다. 빈 데이터베이스의 안내 문구도 검증한다.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- test/worker.integration.test.ts`

Expected: 화면 데이터가 없어 FAIL.

- [x] **Step 3: Write minimal implementation**

최근 작업 50개와 연결된 PR, 최신 verification run을 D1에서 조회한다. 요약 카드와 반응형 작업 카드를 서버 렌더링하고 모든 외부 문자열과 URL을 escape한다.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- test/worker.integration.test.ts`

Expected: PASS.

### Task 3: 마이그레이션, 회귀 검증, 배포

**Files:**
- Modify: `test/migrations.integration.test.ts`
- Modify: `docs/superpowers/plans/2026-07-19-dashboard.md`

**Interfaces:**
- Consumes: Task 1과 Task 2의 routes, session schema, page renderer.

- [x] **Step 1: Verify migration chain**

Run: `npm test -- test/migrations.integration.test.ts`

Expected: 빈 D1에 0001부터 0007까지 적용되고 `dashboard_sessions`가 존재해 PASS.

- [x] **Step 2: Verify all code**

Run: `npm run typecheck && npm test -- --run`

Expected: TypeScript 오류와 테스트 실패가 모두 0건.

- [x] **Step 3: Apply and deploy**

Run: `npx wrangler d1 migrations apply proofops --remote`

Run: `npx wrangler deploy`

Expected: 0007 적용과 새 Worker version 배포 성공.

- [x] **Step 4: Verify live behavior**

Run: `curl -i https://proofops.pp8817.workers.dev/`

Run: `curl -i https://proofops.pp8817.workers.dev/dashboard`

Expected: `/`는 로그인 링크가 있는 200, `/dashboard`는 `/dashboard/login`으로 302.

- [x] **Step 5: Commit and push**

Run: `git add docs/superpowers/plans/2026-07-19-dashboard.md migrations/0007_dashboard_sessions.sql src/dashboard src/index.ts test/worker.integration.test.ts test/migrations.integration.test.ts && git commit -m "feat: ProofOps 읽기 전용 대시보드 추가" && git push origin feat/proofops-mvp`

Expected: 로컬 커밋과 원격 브랜치 SHA가 일치한다.
