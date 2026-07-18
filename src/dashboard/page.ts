// ProofOps 로그인 화면과 읽기 전용 운영 현황 대시보드를 렌더링한다
import type { Actor } from "../auth/authorization";
import type {
  DashboardData,
  DashboardPullRequest,
  DashboardTask,
  DashboardVerification,
} from "./data";

export function renderLanding(): Response {
  return htmlResponse(pageShell("ProofOps", `
    <main class="landing">
      <div class="eyebrow"><span class="live-dot"></span> GitHub 이벤트 연결됨</div>
      <h1>운영 작업의 증거를<br><span>한곳에서 확인하세요.</span></h1>
      <p class="lead">Notion 작업부터 PR, 리뷰, CI, 운영 검증까지 팀의 현재 상태를 자동으로 연결합니다.</p>
      <a class="primary" href="/dashboard/login">GitHub로 로그인</a>
      <a class="health" href="/health">서비스 상태 확인</a>
      <div class="steps">
        <div><strong>01</strong><span>작업 연결</span></div>
        <div><strong>02</strong><span>PR · CI 추적</span></div>
        <div><strong>03</strong><span>배포 검증</span></div>
      </div>
    </main>`, landingStyles()));
}

export function renderDashboard(actor: Actor, data: DashboardData): Response {
  const pullRequests = data.tasks.flatMap((task) => task.pullRequests);
  const verifications = data.tasks.flatMap((task) => task.verifications);
  const reviewNeeded = pullRequests.filter(
    ({ state, reviewState }) => state === "open" && reviewState !== "approved",
  ).length;
  const failedCi = pullRequests.filter(({ ciState }) => ciState === "failed").length;
  const failedVerification = verifications.filter(({ status }) => status === "failed").length;
  const content = data.tasks.length
    ? data.tasks.map(taskCard).join("")
    : `<section class="empty">
        <div class="empty-icon">✓</div>
        <h2>아직 추적 중인 작업이 없습니다.</h2>
        <p>Codex 또는 Claude Code에서 <code>start_task</code>를 실행하면 여기에 표시됩니다.</p>
      </section>`;

  return htmlResponse(pageShell("ProofOps Dashboard", `
    <header class="topbar">
      <a class="brand" href="/dashboard"><span class="brand-mark">P</span> ProofOps</a>
      <div class="account"><span>@${escapeHtml(actor.githubLogin)}</span>
        <form method="post" action="/dashboard/logout"><button>로그아웃</button></form>
      </div>
    </header>
    <main class="dashboard">
      <div class="heading"><div><p class="eyebrow">LANDIT OPERATIONS</p><h1>작업 현황</h1></div>
        <p class="updated">GitHub 이벤트 기준 자동 업데이트</p></div>
      <section class="metrics">
        ${metric("추적 작업", data.tasks.length, "neutral")}
        ${metric("리뷰 대기", reviewNeeded, reviewNeeded ? "warning" : "success")}
        ${metric("CI 실패", failedCi, failedCi ? "danger" : "success")}
        ${metric("검증 실패", failedVerification, failedVerification ? "danger" : "success")}
      </section>
      <section class="task-list">${content}</section>
    </main>`, dashboardStyles()));
}

function metric(label: string, value: number, tone: string): string {
  return `<article class="metric ${tone}"><span>${escapeHtml(label)}</span><strong>${value}</strong></article>`;
}

function taskCard(task: DashboardTask): string {
  const repositories = task.expectedRepositories
    .map((repository) => `<span class="repo">${escapeHtml(repository)}</span>`)
    .join("");
  const pullRequests = task.pullRequests.length
    ? task.pullRequests.map(pullRequestRow).join("")
    : `<p class="muted">연결된 PR이 없습니다.</p>`;
  const verifications = task.verifications.length
    ? task.verifications.map(verificationRow).join("")
    : `<p class="muted">아직 운영 검증 결과가 없습니다.</p>`;
  return `<article class="task-card">
    <div class="task-head">
      <div><div class="repos">${repositories}</div><h2>${escapeHtml(task.title)}</h2></div>
      <span class="status ${tone(task.technicalStatus)}">${escapeHtml(task.technicalStatus)}</span>
    </div>
    <div class="task-meta"><a href="${safeUrl(task.notionUrl)}" target="_blank" rel="noreferrer">Notion 이슈 ↗</a><span>업데이트 ${formatDate(task.updatedAt)}</span></div>
    <div class="evidence-grid">
      <section><h3>Pull requests</h3>${pullRequests}</section>
      <section><h3>Production verification</h3>${verifications}</section>
    </div>
  </article>`;
}

function pullRequestRow(pullRequest: DashboardPullRequest): string {
  return `<a class="evidence-row" href="${safeUrl(pullRequest.url)}" target="_blank" rel="noreferrer">
    <span class="evidence-main"><strong>${escapeHtml(pullRequest.repository)} #${pullRequest.number}</strong><small>${escapeHtml(pullRequest.state)}</small></span>
    <span class="badges"><i class="badge ${tone(pullRequest.reviewState)}">${escapeHtml(pullRequest.reviewState)}</i><i class="badge ${tone(pullRequest.ciState)}">${escapeHtml(pullRequest.ciState)}</i></span>
  </a>`;
}

function verificationRow(verification: DashboardVerification): string {
  return `<a class="evidence-row" href="${safeUrl(verification.evidenceUrl)}" target="_blank" rel="noreferrer">
    <span class="evidence-main"><strong>${escapeHtml(verification.repository)}</strong><small>${escapeHtml(verification.environment)} · ${escapeHtml(verification.checks)}</small></span>
    <i class="badge ${tone(verification.status)}">${escapeHtml(verification.status)}</i>
  </a>`;
}

function tone(status: string): string {
  const value = status.toLowerCase();
  if (["passed", "approved", "verified", "done", "merged"].includes(value)) return "success";
  if (["failed", "changes_requested", "blocked"].includes(value)) return "danger";
  if (["pending", "in review", "in progress", "open"].includes(value)) return "warning";
  return "neutral";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? escapeHtml(url.toString()) : "#";
  } catch {
    return "#";
  }
}

function pageShell(title: string, body: string, styles: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${baseStyles()}${styles}</style></head><body>${body}</body></html>`;
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function baseStyles(): string {
  return `*{box-sizing:border-box}html{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7f9;color:#17211b}body{margin:0}a{color:inherit}button{font:inherit}`;
}

function landingStyles(): string {
  return `.landing{min-height:100vh;max-width:940px;margin:auto;padding:12vh 32px 48px;display:flex;flex-direction:column;align-items:flex-start;background:radial-gradient(circle at 75% 20%,#d9f7df 0,transparent 36%)}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.14em;color:#557060}.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#20a958;margin-right:8px;box-shadow:0 0 0 5px #dff6e6}.landing h1{font-size:clamp(44px,8vw,82px);line-height:1.02;letter-spacing:-.055em;margin:32px 0 24px;max-width:900px}.landing h1 span{color:#279455}.lead{font-size:18px;line-height:1.65;color:#617069;max-width:590px;margin:0 0 36px}.primary{background:#17211b;color:white;padding:15px 22px;border-radius:12px;text-decoration:none;font-weight:750;box-shadow:0 12px 28px #17211b26}.health{font-size:13px;color:#617069;margin:18px 0 60px}.steps{width:100%;display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #dbe2dd}.steps div{padding:24px 0;display:flex;gap:16px}.steps strong{color:#279455}.steps span{font-weight:700}@media(max-width:600px){.landing{padding:10vh 22px 32px}.steps{grid-template-columns:1fr}.steps div{border-bottom:1px solid #e2e7e3}.landing h1{font-size:48px}}`;
}

function dashboardStyles(): string {
  return `.topbar{height:68px;padding:0 max(24px,calc((100vw - 1180px)/2));display:flex;align-items:center;justify-content:space-between;background:#fff;border-bottom:1px solid #e1e6e3}.brand{font-weight:850;text-decoration:none;display:flex;align-items:center;gap:10px}.brand-mark{display:grid;place-items:center;width:30px;height:30px;background:#279455;color:white;border-radius:9px}.account{display:flex;align-items:center;gap:14px;font-size:13px;color:#64716a}.account form{margin:0}.account button{border:1px solid #dce2de;background:#fff;border-radius:8px;padding:7px 10px;cursor:pointer}.dashboard{max-width:1180px;margin:auto;padding:48px 24px 80px}.heading{display:flex;align-items:end;justify-content:space-between;margin-bottom:28px}.heading h1{font-size:36px;letter-spacing:-.04em;margin:6px 0 0}.eyebrow{font-size:11px;color:#279455;font-weight:800;letter-spacing:.16em;margin:0}.updated{font-size:12px;color:#819088}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}.metric{background:#fff;border:1px solid #e2e7e4;border-radius:14px;padding:18px 20px;display:flex;align-items:end;justify-content:space-between}.metric span{font-size:13px;color:#68756e}.metric strong{font-size:28px}.metric.danger strong{color:#c84242}.metric.warning strong{color:#b57917}.metric.success strong{color:#279455}.task-list{display:grid;gap:16px}.task-card{background:#fff;border:1px solid #dfe5e1;border-radius:18px;padding:24px;box-shadow:0 8px 28px #1d33220a}.task-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.task-head h2{font-size:21px;letter-spacing:-.025em;margin:10px 0 0}.repos{display:flex;gap:6px;flex-wrap:wrap}.repo{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#63736a;background:#eef2ef;border-radius:5px;padding:4px 7px}.status,.badge{font-style:normal;font-size:11px;font-weight:750;border-radius:999px;padding:6px 9px;white-space:nowrap}.success{background:#e6f7eb;color:#218347}.danger{background:#fdeaea;color:#bd3b3b}.warning{background:#fff4dc;color:#9a6818}.neutral{background:#eef1ef;color:#5e6a63}.task-meta{display:flex;gap:16px;margin:14px 0 22px;font-size:12px;color:#7b8981}.task-meta a{color:#287b49;text-decoration:none}.evidence-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px;border-top:1px solid #edf0ee;padding-top:20px}.evidence-grid h3{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#87938c;margin:0 0 9px}.evidence-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid #f0f2f1;text-decoration:none}.evidence-main{min-width:0;display:flex;flex-direction:column;gap:3px}.evidence-main strong{font-size:13px;overflow:hidden;text-overflow:ellipsis}.evidence-main small{font-size:11px;color:#819088;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.badges{display:flex;gap:5px}.muted{color:#89958e;font-size:12px}.empty{text-align:center;padding:90px 24px;background:#fff;border:1px dashed #ccd6d0;border-radius:18px}.empty-icon{width:44px;height:44px;display:grid;place-items:center;margin:0 auto 16px;background:#e4f7e9;color:#248748;border-radius:50%;font-weight:900}.empty h2{font-size:19px}.empty p{color:#718078;font-size:13px}.empty code{background:#edf2ee;padding:3px 6px;border-radius:5px}@media(max-width:800px){.metrics{grid-template-columns:1fr 1fr}.evidence-grid{grid-template-columns:1fr}.heading{align-items:start;flex-direction:column;gap:8px}}@media(max-width:520px){.topbar{padding:0 16px}.dashboard{padding:32px 16px 60px}.metrics{grid-template-columns:1fr 1fr}.metric{padding:15px}.task-card{padding:18px}.task-head{flex-direction:column}.updated{display:none}.account>span{display:none}.badges{flex-direction:column;align-items:end}}`;
}
