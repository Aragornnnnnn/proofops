// GitHub 런타임 검증 요청과 결과 아티팩트의 신뢰 경계를 검증한다
import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { GitHubAppClient } from "./app-client";
import type { VerificationResult } from "../domain/verification-result";
import workflow from "../../landit/proofops-verify.yml?raw";

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () =>
    vi.fn(async (input: { type: string }) => ({
      token: input.type === "app" ? "app-token" : "installation-token",
    })),
}));

const commitSha = "0123456789abcdef0123456789abcdef01234567";
const requestId = "11111111-1111-4111-8111-111111111111";
const evidenceUrl =
  "https://github.com/Aragornnnnnn/landit-be/actions/runs/101";

const validArtifact: VerificationResult = {
  schemaVersion: 1,
  requestId,
  taskId: "task-1",
  repository: "Aragornnnnnn/landit-be",
  environment: "develop",
  commitSha,
  status: "passed",
  checks: [
    {
      name: "deployment",
      status: "passed",
      evidenceUrl,
      summary: "실행 중인 배포가 안정 상태다.",
    },
    {
      name: "ecs",
      status: "passed",
      evidenceUrl,
      summary: "ECS desired count와 running count가 일치한다.",
    },
    {
      name: "alb",
      status: "passed",
      evidenceUrl,
      summary: "ALB 대상이 모두 healthy 상태다.",
    },
    {
      name: "api",
      status: "passed",
      evidenceUrl,
      summary: "상태 확인 API가 성공했다.",
    },
    {
      name: "sentry",
      status: "skipped",
      summary: "공통 템플릿의 필수 관측 대상이 아니다.",
    },
  ],
  observedAt: "2026-07-18T00:00:00.000Z",
};

async function verificationArtifactModule() {
  const modulePath = "./verification-artifact";
  return import(modulePath) as Promise<{
    parseVerificationArtifact: (
      input: unknown,
      expected: {
        taskId: string;
        requestId: string;
        repository: string;
        commitSha: string;
        environment: "develop" | "prod";
        evidenceUrl: string;
      },
    ) => VerificationResult;
    deriveVerificationStatus: (
      result: VerificationResult,
    ) => "passed" | "failed";
  }>;
}

function databaseStub(): D1Database {
  return {} as D1Database;
}

describe("GitHubAppClient.dispatchVerification", () => {
  it.each([
    "attacker/landit-be",
    "Aragornnnnnn/unknown",
    "landit-be",
  ])("전체 owner/repo 허용 목록 밖인 %s 요청을 API 호출 전에 거부한다", async (repository) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GitHubAppClient(
      databaseStub(),
      { appId: "1", privateKey: "test-key" },
      fetcher,
    );

    await expect(
      client.dispatchVerification({
        taskId: "task-1",
        requestId,
        repository,
        environment: "develop",
        commitSha,
      }),
    ).rejects.toThrow("GITHUB_REPOSITORY_NOT_ALLOWED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("develop 검증은 고정 워크플로에 task, 환경, SHA만 전달한다", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 77 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new GitHubAppClient(
      databaseStub(),
      { appId: "1", privateKey: "test-key" },
      fetcher,
    );

    await expect(
      client.dispatchVerification({
        taskId: "task-1",
        requestId,
        repository: "Aragornnnnnn/landit-be",
        environment: "develop",
        commitSha,
      }),
    ).resolves.toEqual({
      workflowRunUrl:
        "https://github.com/Aragornnnnnn/landit-be/actions/workflows/proofops-verify.yml",
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/Aragornnnnnn/landit-be/actions/workflows/proofops-verify.yml/dispatches",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          ref: "main",
          inputs: {
            request_id: requestId,
            task_id: "task-1",
            environment: "develop",
            commit_sha: commitSha,
          },
        }),
      }),
    );
  });

  it("prod도 배포가 아닌 고정 검증 워크플로만 호출한다", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 77 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new GitHubAppClient(
      databaseStub(),
      { appId: "1", privateKey: "test-key" },
      fetcher,
    );

    await client.dispatchVerification({
      taskId: "task-1",
      requestId,
      repository: "Aragornnnnnn/landit-iac",
      environment: "prod",
      commitSha,
    });

    const [url, init] = fetcher.mock.calls.at(-1) ?? [];
    expect(url).toContain("/actions/workflows/proofops-verify.yml/dispatches");
    expect(url).not.toMatch(/deploy/i);
    expect(init?.body).not.toMatch(/deploy/i);
  });
});

describe("GitHubAppClient.getVerificationArtifact", () => {
  it("이름이 정확한 아티팩트의 표준 JSON 파일만 읽는다", async () => {
    const archive = zipSync({
      "proofops-verification-result.json": strToU8(JSON.stringify(validArtifact)),
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 77 }))
      .mockResolvedValueOnce(
        Response.json({
          artifacts: [
            {
              id: 501,
              name: `proofops-verification-${requestId}`,
              expired: false,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://pipelines.actions.githubusercontent.com/signed/artifact.zip?token=short-lived",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(archive));
    const client = new GitHubAppClient(
      databaseStub(),
      { appId: "1", privateKey: "test-key" },
      fetcher,
    );

    await expect(
      client.getVerificationArtifact({
        repository: "Aragornnnnnn/landit-be",
        workflowRunId: 101,
        requestId,
      }),
    ).resolves.toEqual(validArtifact);
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "https://api.github.com/repos/Aragornnnnnn/landit-be/actions/artifacts/501/zip",
      expect.objectContaining({ redirect: "manual" }),
    );
    const [, downloadInit] = fetcher.mock.calls[3];
    const downloadHeaders = new Headers(downloadInit?.headers);
    expect(downloadHeaders.get("authorization")).toBeNull();
    expect(downloadHeaders.get("cookie")).toBeNull();
  });

  it("예상 JSON 파일이 없는 ZIP을 거부한다", async () => {
    const archive = zipSync({ "other.json": strToU8("{}") });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 77 }))
      .mockResolvedValueOnce(
        Response.json({
          artifacts: [
            {
              id: 501,
              name: `proofops-verification-${requestId}`,
              expired: false,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://pipelines.actions.githubusercontent.com/a" },
        }),
      )
      .mockResolvedValueOnce(new Response(archive));
    const client = new GitHubAppClient(
      databaseStub(),
      { appId: "1", privateKey: "test-key" },
      fetcher,
    );

    await expect(
      client.getVerificationArtifact({
        repository: "Aragornnnnnn/landit-be",
        workflowRunId: 101,
        requestId,
      }),
    ).rejects.toThrow("GITHUB_VERIFICATION_ARTIFACT_INVALID");
  });

  it("GitHub Actions artifact 정책 밖의 redirect host를 fetch하지 않는다", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 77 }))
      .mockResolvedValueOnce(
        Response.json({
          artifacts: [
            {
              id: 501,
              name: `proofops-verification-${requestId}`,
              expired: false,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/artifact.zip" },
        }),
      );
    const client = new GitHubAppClient(
      databaseStub(),
      { appId: "1", privateKey: "test-key" },
      fetcher,
    );

    await expect(
      client.getVerificationArtifact({
        repository: "Aragornnnnnn/landit-be",
        workflowRunId: 101,
        requestId,
      }),
    ).rejects.toThrow("GITHUB_VERIFICATION_ARTIFACT_INVALID");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("1 MiB를 넘는 streaming body를 즉시 cancel한다", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(600_000);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 77 }))
      .mockResolvedValueOnce(
        Response.json({
          artifacts: [
            {
              id: 501,
              name: `proofops-verification-${requestId}`,
              expired: false,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://pipelines.actions.githubusercontent.com/a" },
        }),
      )
      .mockResolvedValueOnce(new Response(body));
    const client = new GitHubAppClient(
      databaseStub(),
      { appId: "1", privateKey: "test-key" },
      fetcher,
    );

    await expect(
      client.getVerificationArtifact({
        repository: "Aragornnnnnn/landit-be",
        workflowRunId: 101,
        requestId,
      }),
    ).rejects.toThrow("GITHUB_VERIFICATION_ARTIFACT_INVALID");
    expect(cancelled).toBe(true);
  });
});

describe("parseVerificationArtifact", () => {
  const expected = {
    taskId: "task-1",
    requestId,
    repository: "Aragornnnnnn/landit-be",
    commitSha,
    environment: "develop" as const,
    evidenceUrl,
  };

  it("문맥과 스키마가 맞는 결과를 허용한다", async () => {
    const { parseVerificationArtifact } = await verificationArtifactModule();

    expect(parseVerificationArtifact(validArtifact, expected)).toEqual(validArtifact);
  });

  it.each([
    ["잘못된 버전", { schemaVersion: 2 }],
    ["다른 task ID", { taskId: "task-other" }],
    ["다른 request ID", { requestId: "22222222-2222-4222-8222-222222222222" }],
    ["다른 commit SHA", { commitSha: "f".repeat(40) }],
    ["다른 저장소", { repository: "Aragornnnnnn/landit-ai" }],
    ["다른 환경", { environment: "prod" }],
  ])("%s 결과를 거부한다", async (_case, change) => {
    const { parseVerificationArtifact } = await verificationArtifactModule();

    expect(() =>
      parseVerificationArtifact({ ...validArtifact, ...change }, expected),
    ).toThrow("VERIFICATION_ARTIFACT_INVALID");
  });

  it.each([
    "AWS_ACCESS_KEY_ID=AKIA0123456789ABCDEF",
    "authorization: Bearer github_pat_1234567890abcdef",
    "-----BEGIN PRIVATE KEY-----",
    "password=my-production-password",
  ])("summary의 명백한 비밀값을 거부한다", async (summary) => {
    const { parseVerificationArtifact } = await verificationArtifactModule();
    const artifact = {
      ...validArtifact,
      checks: validArtifact.checks.map((check, index) =>
        index === 0 ? { ...check, summary } : check,
      ),
    };

    expect(() => parseVerificationArtifact(artifact, expected)).toThrow(
      "VERIFICATION_ARTIFACT_INVALID",
    );
  });

  it.each([
    `${evidenceUrl}?token=credential`,
    `${evidenceUrl}#fragment`,
    "https://user:password@github.com/Aragornnnnnn/landit-be/actions/runs/101",
    "https://github.com/Aragornnnnnn/landit-be/actions/runs/999",
  ])("trusted workflow run URL과 다른 evidenceUrl %s를 거부한다", async (url) => {
    const { parseVerificationArtifact } = await verificationArtifactModule();
    const artifact = {
      ...validArtifact,
      checks: validArtifact.checks.map((check) =>
        check.evidenceUrl ? { ...check, evidenceUrl: url } : check,
      ),
    };

    expect(() => parseVerificationArtifact(artifact, expected)).toThrow(
      "VERIFICATION_ARTIFACT_INVALID",
    );
  });
});

describe("proofops-verify workflow security contract", () => {
  it("request ID를 run-name과 artifact에 결합한다", () => {
    expect(workflow).toContain(
      "run-name: ProofOps verification ${{ inputs.request_id }}",
    );
    expect(workflow).toContain("request_id:");
    expect(workflow).toContain("requestId: $request_id");
    expect(workflow).toContain("name: proofops-verification-${{ inputs.request_id }}");
  });

  it("ECS task definition image가 target commit SHA를 포함하는지 실제로 검사한다", () => {
    expect(workflow).toContain("aws ecs describe-task-definition");
    expect(workflow).toMatch(/containerDefinitions/);
    expect(workflow).toMatch(/PROOFOPS_COMMIT_SHA/);
    expect(workflow).toMatch(/image_provenance_status/);
    expect(workflow).not.toMatch(/deployment_status="passed"[\s\S]{0,300}commitSha: \$commit_sha/);
  });

  it("모든 third-party Action을 전체 commit SHA로 고정한다", () => {
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s]+)$/gm)].map(
      (match) => match[1],
    );
    expect(uses).not.toHaveLength(0);
    expect(uses.every((value) => /@[0-9a-f]{40}$/.test(value))).toBe(true);
  });
});

describe("deriveVerificationStatus", () => {
  it("필수 check가 모두 통과하고 증거가 있을 때만 passed다", async () => {
    const { deriveVerificationStatus } = await verificationArtifactModule();

    expect(deriveVerificationStatus(validArtifact)).toBe("passed");
  });

  it.each([
    [
      "필수 check 누락",
      validArtifact.checks.filter((check) => check.name !== "alb"),
    ],
    [
      "필수 check unobservable",
      validArtifact.checks.map((check) =>
        check.name === "ecs" ? { ...check, status: "unobservable" as const } : check,
      ),
    ],
    [
      "통과한 필수 check 증거 누락",
      validArtifact.checks.map((check) => {
        if (check.name !== "api") return check;
        const { evidenceUrl: _evidenceUrl, ...withoutEvidence } = check;
        return withoutEvidence;
      }),
    ],
  ])("%s은 failed로 닫는다", async (_case, checks) => {
    const { deriveVerificationStatus } = await verificationArtifactModule();

    expect(
      deriveVerificationStatus({ ...validArtifact, checks }),
    ).toBe("failed");
  });
});
