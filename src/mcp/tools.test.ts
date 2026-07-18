// 검증 요청 문맥을 dispatch 전에 저장하고 상태를 내구성 있게 갱신하는지 검증한다
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPort } from "../github/app-client";
import type { NotionPort } from "../notion/service";
import type { SentryPort } from "../sentry/client";
import { createProofOpsTools, requestVerification } from "./tools";

const requestId = "11111111-1111-4111-8111-111111111111";
const commitSha = "0123456789abcdef0123456789abcdef01234567";
const timestamp = "2026-07-18T00:00:00.000Z";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        notion_page_id TEXT NOT NULL UNIQUE,
        notion_url TEXT NOT NULL,
        title TEXT NOT NULL,
        technical_status TEXT NOT NULL,
        expected_repositories TEXT NOT NULL,
        last_sync_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS progress_notes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_url TEXT,
        actor_github_user_id INTEGER,
        created_at TEXT NOT NULL
      )`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        actor_github_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'succeeded',
        idempotency_key TEXT,
        updated_at TEXT,
        error_code TEXT,
        operation_id TEXT,
        input_hash TEXT
      )`),
    env.DB.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS audit_events_operation_id_idx
      ON audit_events(operation_id) WHERE operation_id IS NOT NULL`),
    env.DB.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS audit_events_idempotency_key_idx
      ON audit_events(idempotency_key) WHERE idempotency_key IS NOT NULL`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS pull_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        pr_url TEXT NOT NULL,
        state TEXT NOT NULL,
        review_state TEXT NOT NULL,
        ci_state TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repository, pr_number)
      )`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS verification_requests (
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
      )`),
    env.DB
      .prepare(
        `INSERT INTO tasks (
          id, notion_page_id, notion_url, title, technical_status,
          expected_repositories, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "task-1",
        "notion-1",
        "https://notion.so/notion-1",
        "검증 요청",
        "Verifying",
        '["landit-be"]',
        timestamp,
        timestamp,
      ),
    env.DB
      .prepare(
        `INSERT INTO pull_requests (
          id, task_id, repository, pr_number, pr_url, state, review_state,
          ci_state, head_sha, linked_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "pr-1",
        "task-1",
        "Aragornnnnnn/landit-be",
        42,
        "https://github.com/Aragornnnnnn/landit-be/pull/42",
        "merged",
        "approved",
        "passed",
        commitSha,
        timestamp,
        timestamp,
      ),
  ]);
});

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER IF EXISTS fail_dispatched_update"),
    env.DB.prepare("DROP TRIGGER IF EXISTS fail_record_progress_audit"),
    env.DB.prepare("DROP TRIGGER IF EXISTS fail_create_notion_terminal_audit"),
    env.DB.prepare("DROP TRIGGER IF EXISTS fail_effect_start"),
    env.DB.prepare("DELETE FROM verification_requests"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM progress_notes"),
    env.DB.prepare("DELETE FROM pull_requests"),
    env.DB.prepare("DELETE FROM tasks"),
  ]);
});

describe("mutation actor audit", () => {
  it("성공한 다섯 상태 변경에 actor와 resource만 기록한다", async () => {
    const createdIssue = {
      pageId: "notion-created",
      url: "https://notion.so/notion-created",
      title: "생성된 이슈",
      description: "",
      acceptanceCriteria: [],
      repositories: ["landit-be"],
      currentTechnicalStatus: null,
    };
    const notion: NotionPort = {
      getIssue: vi.fn().mockResolvedValue({
        ...createdIssue,
        pageId: "notion-started",
        url: "https://notion.so/notion-started",
        title: "시작할 작업",
      }),
      updateTechnicalStatus: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(createdIssue),
    };
    const github: GitHubPort = {
      getPullRequest: vi.fn().mockResolvedValue({
        repository: "Aragornnnnnn/landit-be",
        number: 43,
        url: "https://github.com/Aragornnnnnn/landit-be/pull/43",
        state: "open",
        review: "pending",
        ci: "pending",
        headSha: "fedcba9876543210fedcba9876543210fedcba98",
      }),
      getTaskSnapshot: vi.fn().mockResolvedValue({
        started: true,
        expectedRepositories: ["landit-be"],
        pullRequests: [],
        deployment: "none",
        requiredVerification: "pending",
      }),
      dispatchVerification: vi.fn().mockResolvedValue({
        workflowRunUrl:
          "https://github.com/Aragornnnnnn/landit-be/actions/workflows/proofops-verify.yml",
      }),
      getVerificationArtifact: vi.fn().mockRejectedValue(new Error("not used")),
    };
    const sentry: SentryPort = {
      investigateIncident: vi.fn().mockRejectedValue(new Error("not used")),
    };
    const tools = createProofOpsTools(
      env,
      { githubUserId: 101, githubLogin: "alice" },
      { github, notion, sentry },
    );

    const started = await tools.startTask({
      operationId: "10000000-0000-4000-8000-000000000001",
      notionPageIdOrUrl: "notion-started",
    });
    await tools.linkPullRequest({
      operationId: "10000000-0000-4000-8000-000000000002",
      taskId: "task-1",
      pullRequestUrl: "https://github.com/Aragornnnnnn/landit-be/pull/43",
    });
    const note = await tools.recordProgress({
      taskId: "task-1",
      kind: "test",
      summary: "검증 통과",
    });
    const verification = await tools.requestVerification({
      operationId: "10000000-0000-4000-8000-000000000003",
      taskId: "task-1",
      repository: "Aragornnnnnn/landit-be",
      environment: "develop",
      commitSha,
    });
    const notionIssue = await tools.createNotionIssue({
      operationId: "10000000-0000-4000-8000-000000000004",
      title: "운영 이슈",
      impact: "영향",
      evidence: [],
      causeOrHypothesis: "가설",
      scope: ["proofops"],
      acceptanceCriteria: ["해결"],
    });

    const events = await env.DB
      .prepare(
        `SELECT actor_github_user_id, action, resource_type, resource_id, status
         FROM audit_events ORDER BY action`,
      )
      .all();
    expect(events.results).toEqual([
      {
        actor_github_user_id: 101,
        action: "create_notion_issue",
        resource_type: "notion_issue",
        resource_id: notionIssue.pageId,
        status: "succeeded",
      },
      {
        actor_github_user_id: 101,
        action: "link_pull_request",
        resource_type: "task",
        resource_id: "task-1",
        status: "succeeded",
      },
      {
        actor_github_user_id: 101,
        action: "record_progress",
        resource_type: "progress_note",
        resource_id: note.id,
        status: "succeeded",
      },
      {
        actor_github_user_id: 101,
        action: "request_verification",
        resource_type: "verification_request",
        resource_id: verification.requestId,
        status: "succeeded",
      },
      {
        actor_github_user_id: 101,
        action: "start_task",
        resource_type: "task",
        resource_id: started.id,
        status: "succeeded",
      },
    ]);
  });

  it("Notion 생성 여부가 불확실하면 reconcile_required로 유지한다", async () => {
    const tools = createProofOpsTools(
      env,
      { githubUserId: 101, githubLogin: "alice" },
      {
        notion: {
          getIssue: vi.fn().mockRejectedValue(new Error("NOTION_READ_FAILED")),
          updateTechnicalStatus: vi.fn(),
          createIssue: vi.fn().mockRejectedValue(new Error("NOTION_CREATE_FAILED")),
        },
      },
    );

    await expect(
      tools.createNotionIssue({
        operationId: "10000000-0000-4000-8000-000000000005",
        title: "실패",
        impact: "영향",
        evidence: [],
        causeOrHypothesis: "가설",
        scope: [],
        acceptanceCriteria: [],
      }),
    ).rejects.toThrow("OPERATION_RECONCILE_REQUIRED");
    await expect(env.DB.prepare(
      "SELECT actor_github_user_id, action, status, error_code FROM audit_events",
    ).first()).resolves.toEqual({
      actor_github_user_id: 101,
      action: "create_notion_issue",
      status: "reconcile_required",
      error_code: "OPERATION_RECONCILE_REQUIRED",
    });
  });

  it("mutation 전 읽기 실패만 failed_retryable로 기록하고 안전하게 재시도한다", async () => {
    const issue = {
      pageId: "notion-retryable",
      url: "https://notion.so/notion-retryable",
      title: "재시도 작업",
      description: "",
      acceptanceCriteria: [],
      repositories: [],
      currentTechnicalStatus: null,
    };
    const getIssue = vi
      .fn()
      .mockRejectedValueOnce(new Error("NOTION_READ_FAILED"))
      .mockResolvedValueOnce(issue);
    const tools = createProofOpsTools(
      env,
      { githubUserId: 101, githubLogin: "alice" },
      {
        notion: {
          getIssue,
          updateTechnicalStatus: vi.fn().mockResolvedValue(undefined),
          createIssue: vi.fn(),
        },
        github: {
          getPullRequest: vi.fn(),
          getTaskSnapshot: vi.fn().mockResolvedValue({
            started: true,
            expectedRepositories: [],
            pullRequests: [],
            deployment: "none",
            requiredVerification: "pending",
          }),
          dispatchVerification: vi.fn(),
          getVerificationArtifact: vi.fn(),
        },
      },
    );
    const input = {
      operationId: "10000000-0000-4000-8000-000000000006",
      notionPageIdOrUrl: issue.pageId,
    };

    await expect(tools.startTask(input)).rejects.toThrow("NOTION_READ_FAILED");
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first(),
    ).resolves.toEqual({ count: 0 });
    await expect(tools.startTask(input)).resolves.toMatchObject({
      notionPageId: issue.pageId,
    });
    expect(getIssue).toHaveBeenCalledTimes(2);
    await expect(
      env.DB.prepare("SELECT status FROM audit_events").first(),
    ).resolves.toEqual({ status: "succeeded" });
  });

  it("record_progress note와 success audit을 하나의 D1 transaction으로 쓴다", async () => {
    await env.DB
      .prepare(
        `CREATE TRIGGER fail_record_progress_audit
         BEFORE INSERT ON audit_events
         WHEN NEW.action = 'record_progress'
         BEGIN
           SELECT RAISE(ABORT, 'simulated audit insert failure');
         END`,
      )
      .run();
    const tools = createProofOpsTools(
      env,
      { githubUserId: 101, githubLogin: "alice" },
    );

    await expect(
      tools.recordProgress({
        taskId: "task-1",
        kind: "test",
        summary: "원자성 검증",
      }),
    ).rejects.toThrow("simulated audit insert failure");
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM progress_notes").first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("외부 성공 뒤 terminal audit 실패와 retry가 중복 생성을 막는다", async () => {
    await env.DB
      .prepare(
        `CREATE TRIGGER fail_create_notion_terminal_audit
         BEFORE UPDATE OF status ON audit_events
         WHEN OLD.action = 'create_notion_issue' AND NEW.status = 'succeeded'
         BEGIN
           SELECT RAISE(ABORT, 'simulated terminal audit failure');
         END`,
      )
      .run();
    const createdIssue = {
      pageId: "notion-created-once",
      url: "https://notion.so/notion-created-once",
      title: "한 번만 생성",
      description: "",
      acceptanceCriteria: [],
      repositories: [],
      currentTechnicalStatus: null,
    };
    const createIssue = vi.fn().mockResolvedValue(createdIssue);
    const tools = createProofOpsTools(
      env,
      { githubUserId: 101, githubLogin: "alice" },
      {
        notion: {
          getIssue: vi.fn(),
          updateTechnicalStatus: vi.fn(),
          createIssue,
        },
      },
    );
    const input = {
      operationId: "10000000-0000-4000-8000-000000000007",
      title: "중복 방지",
      impact: "영향",
      evidence: [],
      causeOrHypothesis: "가설",
      scope: [],
      acceptanceCriteria: [],
    };

    await expect(tools.createNotionIssue(input)).rejects.toThrow(
      "OPERATION_RECONCILE_REQUIRED",
    );
    await expect(tools.createNotionIssue(input)).rejects.toThrow(
      "OPERATION_RECONCILE_REQUIRED",
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
    await expect(
      env.DB.prepare("SELECT status FROM audit_events").first(),
    ).resolves.toEqual({ status: "reconcile_required" });
  });

  it("succeeded operation 재시도는 저장한 resource를 복구하고 외부 생성을 반복하지 않는다", async () => {
    const createdIssue = {
      pageId: "notion-recovered",
      url: "https://notion.so/notion-recovered",
      title: "복구할 이슈",
      description: "",
      acceptanceCriteria: [],
      repositories: [],
      currentTechnicalStatus: null,
    };
    const createIssue = vi.fn().mockResolvedValue(createdIssue);
    const getIssue = vi.fn().mockResolvedValue(createdIssue);
    const tools = createProofOpsTools(
      env,
      { githubUserId: 101, githubLogin: "alice" },
      {
        notion: {
          getIssue,
          updateTechnicalStatus: vi.fn(),
          createIssue,
        },
      },
    );
    const input = {
      operationId: "10000000-0000-4000-8000-000000000008",
      title: "성공 복구",
      impact: "영향",
      evidence: [],
      causeOrHypothesis: "가설",
      scope: [],
      acceptanceCriteria: [],
    };

    await expect(tools.createNotionIssue(input)).resolves.toEqual(createdIssue);
    await expect(tools.createNotionIssue(input)).resolves.toEqual(createdIssue);

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(getIssue).toHaveBeenCalledWith(createdIssue.pageId);
    await expect(
      env.DB.prepare("SELECT status, resource_id FROM audit_events").first(),
    ).resolves.toEqual({
      status: "succeeded",
      resource_id: createdIssue.pageId,
    });
  });
});

describe("caller operation lifecycle", () => {
  const operationA = "11111111-1111-4111-8111-111111111111";
  const operationB = "22222222-2222-4222-8222-222222222222";
  const baseInput = {
    operationId: operationA,
    title: "중복 방지",
    impact: "영향",
    evidence: [{ label: "근거", url: "https://example.com/evidence" }],
    causeOrHypothesis: "가설",
    scope: ["API"],
    acceptanceCriteria: ["완료"],
  };

  it("같은 operationId를 다른 입력에 재사용하면 충돌하고 외부 호출을 반복하지 않는다", async () => {
    const createIssue = vi.fn().mockImplementation(async (input) => ({
      pageId: `page-${input.title}`,
      url: `https://notion.so/page-${input.title}`,
      title: input.title,
      description: "",
      acceptanceCriteria: [],
      repositories: [],
      currentTechnicalStatus: null,
    }));
    const tools = createProofOpsTools(env, { githubUserId: 101, githubLogin: "alice" }, {
      notion: {
        getIssue: vi.fn(),
        updateTechnicalStatus: vi.fn(),
        createIssue,
        findIssueByOperationMarker: vi.fn(),
      },
    });

    await tools.createNotionIssue(baseInput);
    await expect(
      tools.createNotionIssue({ ...baseInput, title: "다른 입력" }),
    ).rejects.toThrow("OPERATION_CONFLICT");
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it("같은 입력도 새 operationId면 의도적인 후속 생성을 허용한다", async () => {
    const createIssue = vi.fn().mockResolvedValue({
      pageId: "page-created",
      url: "https://notion.so/page-created",
      title: baseInput.title,
      description: "",
      acceptanceCriteria: [],
      repositories: [],
      currentTechnicalStatus: null,
    });
    const tools = createProofOpsTools(env, { githubUserId: 101, githubLogin: "alice" }, {
      notion: {
        getIssue: vi.fn(),
        updateTechnicalStatus: vi.fn(),
        createIssue,
        findIssueByOperationMarker: vi.fn(),
      },
    });

    await tools.createNotionIssue(baseInput);
    await tools.createNotionIssue({ ...baseInput, operationId: operationB });
    expect(createIssue).toHaveBeenCalledTimes(2);
  });

  it("create 응답 유실은 marker로 복구하고 같은 ID 재시도에서 중복 생성하지 않는다", async () => {
    const recovered = {
      pageId: "page-recovered",
      url: "https://notion.so/page-recovered",
      title: baseInput.title,
      description: "",
      acceptanceCriteria: [],
      repositories: [],
      currentTechnicalStatus: null,
    };
    const createIssue = vi.fn().mockRejectedValue(new Error("NOTION_CREATE_FAILED"));
    const findIssueByOperationMarker = vi.fn().mockResolvedValue(recovered);
    const tools = createProofOpsTools(env, { githubUserId: 101, githubLogin: "alice" }, {
      notion: {
        getIssue: vi.fn().mockResolvedValue(recovered),
        updateTechnicalStatus: vi.fn(),
        createIssue,
        findIssueByOperationMarker,
      },
    });

    await expect(tools.createNotionIssue(baseInput)).resolves.toEqual(recovered);
    await expect(tools.createNotionIssue(baseInput)).resolves.toEqual(recovered);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(findIssueByOperationMarker).toHaveBeenCalledWith(operationA);
  });

  it("marker 존재를 증명하지 못하면 reconcile_required로 남기고 생성하지 않는다", async () => {
    const createIssue = vi.fn().mockRejectedValue(new Error("NOTION_CREATE_FAILED"));
    const findIssueByOperationMarker = vi.fn().mockResolvedValue(null);
    const tools = createProofOpsTools(env, { githubUserId: 101, githubLogin: "alice" }, {
      notion: {
        getIssue: vi.fn(),
        updateTechnicalStatus: vi.fn(),
        createIssue,
        findIssueByOperationMarker,
      },
    });

    await expect(tools.createNotionIssue(baseInput)).rejects.toThrow(
      "OPERATION_RECONCILE_REQUIRED",
    );
    await expect(tools.createNotionIssue(baseInput)).rejects.toThrow(
      "OPERATION_RECONCILE_REQUIRED",
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
    await expect(
      env.DB.prepare("SELECT status FROM audit_events WHERE operation_id = ?")
        .bind(operationA)
        .first(),
    ).resolves.toEqual({ status: "reconcile_required" });
  });

  it("read-only validation 실패는 operation을 열지 않아 같은 ID로 안전하게 재시도한다", async () => {
    const issue = {
      pageId: "notion-validation",
      url: "https://notion.so/notion-validation",
      title: "검증",
      description: "",
      acceptanceCriteria: [],
      repositories: [],
      currentTechnicalStatus: null,
    };
    const getIssue = vi.fn().mockRejectedValueOnce(new Error("NOTION_READ_FAILED")).mockResolvedValue(issue);
    const updateTechnicalStatus = vi.fn().mockResolvedValue(undefined);
    const tools = createProofOpsTools(env, { githubUserId: 101, githubLogin: "alice" }, {
      notion: { getIssue, updateTechnicalStatus, createIssue: vi.fn() },
    });
    const input = { operationId: operationA, notionPageIdOrUrl: issue.pageId };

    await expect(tools.startTask(input)).rejects.toThrow("NOTION_READ_FAILED");
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first())
      .resolves.toEqual({ count: 0 });
    await expect(tools.startTask(input)).resolves.toMatchObject({ notionPageId: issue.pageId });
    expect(updateTechnicalStatus).toHaveBeenCalledTimes(1);
  });

  it("effect call 전 crash로 validated에 남은 operation은 같은 ID로 안전하게 시작한다", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER fail_effect_start
       BEFORE UPDATE OF status ON audit_events
       WHEN NEW.status = 'effect_started'
       BEGIN SELECT RAISE(ABORT, 'simulated crash before call'); END`,
    ).run();
    const created = {
      pageId: "page-after-crash",
      url: "https://notion.so/page-after-crash",
      title: baseInput.title,
      description: "",
      acceptanceCriteria: [],
      repositories: [],
      currentTechnicalStatus: null,
    };
    const createIssue = vi.fn().mockResolvedValue(created);
    const tools = createProofOpsTools(env, { githubUserId: 101, githubLogin: "alice" }, {
      notion: { getIssue: vi.fn(), updateTechnicalStatus: vi.fn(), createIssue },
    });

    await expect(tools.createNotionIssue(baseInput)).rejects.toThrow(
      "simulated crash before call",
    );
    expect(createIssue).not.toHaveBeenCalled();
    await env.DB.prepare("DROP TRIGGER fail_effect_start").run();
    await expect(tools.createNotionIssue(baseInput)).resolves.toEqual(created);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it("idempotent start status patch의 확인된 실패는 같은 ID로 재시도한다", async () => {
    const issue = {
      pageId: "notion-patch-retry",
      url: "https://notion.so/notion-patch-retry",
      title: "상태 재시도",
      description: "",
      acceptanceCriteria: [],
      repositories: [],
      currentTechnicalStatus: null,
    };
    const updateTechnicalStatus = vi.fn()
      .mockRejectedValueOnce(new Error("NOTION_STATUS_UPDATE_FAILED"))
      .mockResolvedValueOnce(undefined);
    const tools = createProofOpsTools(env, { githubUserId: 101, githubLogin: "alice" }, {
      notion: { getIssue: vi.fn().mockResolvedValue(issue), updateTechnicalStatus, createIssue: vi.fn() },
    });
    const input = { operationId: operationA, notionPageIdOrUrl: issue.pageId };

    await expect(tools.startTask(input)).rejects.toThrow("NOTION_STATUS_UPDATE_FAILED");
    await expect(tools.startTask(input)).resolves.toMatchObject({ notionPageId: issue.pageId });
    expect(updateTechnicalStatus).toHaveBeenCalledTimes(2);
    await expect(
      env.DB.prepare("SELECT status FROM audit_events WHERE operation_id = ?")
        .bind(operationA)
        .first(),
    ).resolves.toEqual({ status: "succeeded" });
  });

  it("verification 응답 유실은 request ID 상태를 반환하고 같은 ID를 재dispatch하지 않는다", async () => {
    const dispatchVerification = vi.fn().mockRejectedValue(new Error("GITHUB_API_FAILED"));
    const tools = createProofOpsTools(env, { githubUserId: 101, githubLogin: "alice" }, {
      github: {
        getPullRequest: vi.fn(),
        getTaskSnapshot: vi.fn(),
        dispatchVerification,
        getVerificationArtifact: vi.fn(),
      },
      notion: { getIssue: vi.fn(), updateTechnicalStatus: vi.fn(), createIssue: vi.fn() },
    });
    const input = {
      operationId: operationA,
      taskId: "task-1",
      repository: "Aragornnnnnn/landit-be",
      environment: "develop" as const,
      commitSha,
    };

    await expect(tools.requestVerification(input)).resolves.toMatchObject({
      requestId: operationA,
      status: "dispatch_failed",
    });
    await expect(tools.requestVerification(input)).resolves.toMatchObject({
      requestId: operationA,
      status: "dispatch_failed",
    });
    await expect(
      tools.requestVerification({ ...input, operationId: operationB }),
    ).resolves.toMatchObject({ requestId: operationB, status: "dispatch_failed" });
    expect(dispatchVerification).toHaveBeenCalledTimes(2);
  });
});

describe("requestVerification", () => {
  it("전체 요청 문맥을 저장하고 trusted ref dispatch 뒤 상태를 갱신한다", async () => {
    const dispatchVerification = vi.fn().mockResolvedValue({
      workflowRunUrl:
        "https://github.com/Aragornnnnnn/landit-be/actions/workflows/proofops-verify.yml",
    });

    await expect(
      requestVerification(
        {
          taskId: "task-1",
          repository: "Aragornnnnnn/landit-be",
          environment: "develop",
          commitSha,
        },
        {
          db: env.DB,
          github: { dispatchVerification },
          now: () => timestamp,
          newId: () => requestId,
        },
      ),
    ).resolves.toEqual({
      requestId,
      workflowRunUrl:
        "https://github.com/Aragornnnnnn/landit-be/actions/workflows/proofops-verify.yml",
    });
    expect(dispatchVerification).toHaveBeenCalledWith({
      requestId,
      taskId: "task-1",
      repository: "Aragornnnnnn/landit-be",
      environment: "develop",
      commitSha,
    });
    await expect(
      env.DB.prepare("SELECT * FROM verification_requests").first(),
    ).resolves.toMatchObject({
      request_id: requestId,
      task_id: "task-1",
      repository: "Aragornnnnnn/landit-be",
      environment: "develop",
      target_commit_sha: commitSha,
      trusted_ref: "main",
      status: "dispatched",
      workflow_run_id: null,
    });
  });

  it("dispatch 실패도 요청을 지우지 않고 안전한 상태로 남긴다", async () => {
    const dispatchVerification = vi
      .fn()
      .mockRejectedValue(new Error("secret-bearing upstream response"));

    await expect(
      requestVerification(
        {
          taskId: "task-1",
          repository: "Aragornnnnnn/landit-be",
          environment: "develop",
          commitSha,
        },
        {
          db: env.DB,
          github: { dispatchVerification },
          now: () => timestamp,
          newId: () => requestId,
        },
      ),
    ).rejects.toThrow("secret-bearing upstream response");
    await expect(
      env.DB
        .prepare("SELECT status FROM verification_requests WHERE request_id = ?")
        .bind(requestId)
        .first(),
    ).resolves.toEqual({ status: "dispatch_failed" });
  });

  it("GitHub dispatch 성공 뒤 dispatched 갱신이 실패해도 pending을 보존한다", async () => {
    await env.DB
      .prepare(
        `CREATE TRIGGER fail_dispatched_update
         BEFORE UPDATE OF status ON verification_requests
         WHEN NEW.status = 'dispatched'
         BEGIN
           SELECT RAISE(ABORT, 'simulated dispatched update failure');
         END`,
      )
      .run();
    const dispatchVerification = vi.fn().mockResolvedValue({
      workflowRunUrl:
        "https://github.com/Aragornnnnnn/landit-be/actions/workflows/proofops-verify.yml",
    });

    await expect(
      requestVerification(
        {
          taskId: "task-1",
          repository: "Aragornnnnnn/landit-be",
          environment: "develop",
          commitSha,
        },
        {
          db: env.DB,
          github: { dispatchVerification },
          now: () => timestamp,
          newId: () => requestId,
        },
      ),
    ).resolves.toMatchObject({ requestId });
    await expect(
      env.DB
        .prepare("SELECT status FROM verification_requests WHERE request_id = ?")
        .bind(requestId)
        .first(),
    ).resolves.toEqual({ status: "pending" });
  });

  it("빠른 Webhook의 terminal 상태를 post-dispatch 갱신으로 되돌리지 않는다", async () => {
    const dispatchVerification = vi.fn().mockImplementation(async () => {
      await env.DB
        .prepare(
          `UPDATE verification_requests
           SET status = 'passed', workflow_run_id = 777 WHERE request_id = ?`,
        )
        .bind(requestId)
        .run();
      return {
        workflowRunUrl:
          "https://github.com/Aragornnnnnn/landit-be/actions/workflows/proofops-verify.yml",
      };
    });

    await requestVerification(
      {
        taskId: "task-1",
        repository: "Aragornnnnnn/landit-be",
        environment: "develop",
        commitSha,
      },
      {
        db: env.DB,
        github: { dispatchVerification },
        now: () => timestamp,
        newId: () => requestId,
      },
    );

    await expect(
      env.DB
        .prepare(
          "SELECT status, workflow_run_id FROM verification_requests WHERE request_id = ?",
        )
        .bind(requestId)
        .first(),
    ).resolves.toEqual({ status: "passed", workflow_run_id: 777 });
  });
});
