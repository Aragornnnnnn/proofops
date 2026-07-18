// GitHub 리뷰 최신 상태 집계와 API 페이지네이션을 검증한다
import { describe, expect, it, vi } from "vitest";
import {
  collectGitHubPages,
  deriveCurrentReviewState,
  GitHubAppClient,
  type GitHubReview,
} from "./app-client";
import { deriveTechnicalStatus } from "../domain/task-status";

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () =>
    vi.fn(async (input: { type: string }) => ({
      token: input.type === "app" ? "app-token" : "installation-token",
    })),
}));

describe("GitHubAppClient.getPullRequest", () => {
  it("Worker 전역 fetch를 this 바인딩 없이 호출한다", async () => {
    const headSha = "a".repeat(40);
    const workerFetch = vi.fn(async function (
      this: unknown,
      input: RequestInfo | URL,
    ): Promise<Response> {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/installation")) return json({ id: 1001 });
      if (url.endsWith("/pulls/1")) {
        return json({
          html_url: "https://github.com/Aragornnnnnn/proofops-sandbox/pull/1",
          state: "open",
          merged: false,
          merged_at: null,
          head: { sha: headSha },
          base: { repo: { full_name: "Aragornnnnnn/proofops-sandbox" } },
          number: 1,
        });
      }
      if (url.includes("/reviews?")) return json([]);
      if (url.includes("/check-runs?")) {
        return json({
          check_runs: [{ status: "completed", conclusion: "success" }],
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", workerFetch);

    try {
      const client = new GitHubAppClient({} as D1Database, {
        appId: "1",
        privateKey: "test-key",
      });

      await expect(
        client.getPullRequest(
          "https://github.com/Aragornnnnnn/proofops-sandbox/pull/1",
        ),
      ).resolves.toMatchObject({
        repository: "Aragornnnnnn/proofops-sandbox",
        number: 1,
        headSha,
        state: "open",
        review: "pending",
        ci: "passed",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("deriveCurrentReviewState", () => {
  it("같은 리뷰어의 이전 변경 요청 뒤 승인을 현재 상태로 사용한다", () => {
    const reviews: GitHubReview[] = [
      {
        id: 1,
        reviewerId: 7,
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-18T00:00:00.000Z",
      },
      {
        id: 2,
        reviewerId: 7,
        state: "APPROVED",
        submittedAt: "2026-07-18T00:10:00.000Z",
      },
      {
        id: 3,
        reviewerId: 8,
        state: "DISMISSED",
        submittedAt: "2026-07-18T00:20:00.000Z",
      },
    ];

    expect(deriveCurrentReviewState(reviews)).toBe("approved");
  });
});

describe("collectGitHubPages", () => {
  it("100건을 넘는 리뷰를 다음 페이지까지 모두 조회한다", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => index + 1);
    const fetchPage = vi
      .fn<(page: number, perPage: number) => Promise<number[]>>()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([101]);

    const result = await collectGitHubPages(fetchPage);

    expect(result).toHaveLength(101);
    expect(fetchPage.mock.calls).toEqual([
      [1, 100],
      [2, 100],
    ]);
  });
});

describe("GitHubAppClient.getTaskSnapshot", () => {
  it("저장소별 최신 verification run 실패를 작업 snapshot에 반영한다", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          all: async () => ({
            results: query.includes("verification_runs")
              ? [
                  {
                    repository: "Aragornnnnnn/landit-be",
                    status: "failed",
                    commit_sha: "current",
                  },
                ]
              : [
                  {
                    repository: "Aragornnnnnn/landit-be",
                    pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
                  },
                ],
          }),
          first: async () => ({ expected_repositories: '["landit-be"]' }),
        }),
      }),
    } as unknown as D1Database;
    const client = new GitHubAppClient(database, { appId: "1", privateKey: "key" });
    vi.spyOn(client, "getPullRequest").mockResolvedValue({
      repository: "Aragornnnnnn/landit-be",
      number: 11,
      url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
      headSha: "current",
      state: "merged",
      review: "approved",
      ci: "passed",
    });

    await expect(client.getTaskSnapshot("task-1")).resolves.toMatchObject({
      requiredVerification: "failed",
    });
  });

  it("SHA A의 passed 결과를 현재 선택된 SHA B에 재사용하지 않는다", async () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          all: async () => ({
            results: query.includes("verification_runs")
              ? [
                  {
                    repository: "Aragornnnnnn/landit-be",
                    status: "passed",
                    commit_sha: shaA,
                  },
                ]
              : [
                  {
                    repository: "Aragornnnnnn/landit-be",
                    pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
                  },
                ],
          }),
          first: async () => ({ expected_repositories: '["landit-be"]' }),
        }),
      }),
    } as unknown as D1Database;
    const client = new GitHubAppClient(database, { appId: "1", privateKey: "key" });
    vi.spyOn(client, "getPullRequest").mockResolvedValue({
      repository: "Aragornnnnnn/landit-be",
      number: 11,
      url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
      headSha: shaB,
      state: "merged",
      review: "approved",
      ci: "passed",
    });

    await expect(client.getTaskSnapshot("task-1")).resolves.toMatchObject({
      requiredVerification: "pending",
      deployment: "none",
    });
  });

  it("Webhook 도착 시각이 아니라 큰 workflow_run_id 결과를 최신으로 집계한다", async () => {
    const sha = "c".repeat(40);
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          all: async () => ({
            results: query.includes("verification_runs")
              ? query.includes("ORDER BY workflow_run_id DESC")
                ? [
                    {
                      repository: "Aragornnnnnn/landit-be",
                      status: "failed",
                      commit_sha: sha,
                    },
                    {
                      repository: "Aragornnnnnn/landit-be",
                      status: "passed",
                      commit_sha: sha,
                    },
                  ]
                : [
                    {
                      repository: "Aragornnnnnn/landit-be",
                      status: "passed",
                      commit_sha: sha,
                    },
                    {
                      repository: "Aragornnnnnn/landit-be",
                      status: "failed",
                      commit_sha: sha,
                    },
                  ]
              : [
                  {
                    repository: "Aragornnnnnn/landit-be",
                    pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
                  },
                ],
          }),
          first: async () => ({ expected_repositories: '["landit-be"]' }),
        }),
      }),
    } as unknown as D1Database;
    const client = new GitHubAppClient(database, { appId: "1", privateKey: "key" });
    vi.spyOn(client, "getPullRequest").mockResolvedValue({
      repository: "Aragornnnnnn/landit-be",
      number: 11,
      url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
      headSha: sha,
      state: "merged",
      review: "approved",
      ci: "passed",
    });

    await expect(client.getTaskSnapshot("task-1")).resolves.toMatchObject({
      requiredVerification: "failed",
    });
  });

  it("예상 저장소별 최신 연결 PR만 현재 상태로 조회한다", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          all: async () => ({
            results: [
              {
                repository: "Aragornnnnnn/landit-be",
                pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
              },
              {
                repository: "Aragornnnnnn/landit-be",
                pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/10",
              },
              {
                repository: "Aragornnnnnn/landit-ai",
                pr_url: "https://github.com/Aragornnnnnn/landit-ai/pull/20",
              },
              {
                repository: "Aragornnnnnn/landit-fe",
                pr_url: "https://github.com/Aragornnnnnn/landit-fe/pull/30",
              },
            ],
          }),
          first: async () =>
            query.includes("expected_repositories")
              ? { expected_repositories: '["landit-be", "landit-ai"]' }
              : null,
        }),
      }),
    } as unknown as D1Database;
    const client = new GitHubAppClient(database, { appId: "1", privateKey: "key" });
    const getPullRequest = vi
      .spyOn(client, "getPullRequest")
      .mockImplementation(async (url) => ({
        repository: url.includes("landit-ai")
          ? "Aragornnnnnn/landit-ai"
          : "Aragornnnnnn/landit-be",
        number: url.endsWith("/20") ? 20 : 11,
        url,
        headSha: "current",
        state: "merged",
        review: "approved",
        ci: "passed",
      }));

    await expect(client.getTaskSnapshot("task-1")).resolves.toMatchObject({
      expectedRepositories: ["landit-be", "landit-ai"],
      pullRequests: [
        expect.objectContaining({ repository: "Aragornnnnnn/landit-be", number: 11 }),
        expect.objectContaining({ repository: "Aragornnnnnn/landit-ai", number: 20 }),
      ],
    });
    expect(getPullRequest).toHaveBeenCalledTimes(2);
    expect(getPullRequest).toHaveBeenCalledWith(
      "https://github.com/Aragornnnnnn/landit-be/pull/11",
    );
    expect(getPullRequest).not.toHaveBeenCalledWith(
      "https://github.com/Aragornnnnnn/landit-be/pull/10",
    );
  });

  it("늦은 이전 PR 상태 갱신보다 새로 연결된 열린 PR을 우선한다", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: () => ({
          all: async () => ({
            results: query.includes("linked_at DESC")
              ? [
                  {
                    repository: "Aragornnnnnn/landit-be",
                    pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
                  },
                  {
                    repository: "Aragornnnnnn/landit-be",
                    pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/10",
                  },
                ]
              : [
                  {
                    repository: "Aragornnnnnn/landit-be",
                    pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/10",
                  },
                  {
                    repository: "Aragornnnnnn/landit-be",
                    pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
                  },
                ],
          }),
          first: async () => ({ expected_repositories: '["landit-be"]' }),
        }),
      }),
    } as unknown as D1Database;
    const client = new GitHubAppClient(database, { appId: "1", privateKey: "key" });
    vi.spyOn(client, "getPullRequest").mockImplementation(async (url) => ({
      repository: "Aragornnnnnn/landit-be",
      number: url.endsWith("/11") ? 11 : 10,
      url,
      headSha: "current",
      state: url.endsWith("/11") ? "open" : "merged",
      review: "approved",
      ci: "passed",
    }));

    const snapshot = await client.getTaskSnapshot("task-1");

    expect(snapshot.pullRequests).toEqual([
      expect.objectContaining({ number: 11, state: "open" }),
    ]);
    expect(
      deriveTechnicalStatus({
        ...snapshot,
        deployment: "succeeded",
        requiredVerification: "passed",
      }),
    ).not.toBe("Done");
  });

  it("다른 작업으로 재연결된 PR의 새 링크 시점으로 최신 PR을 선택한다", async () => {
    const database = {
      prepare: (query: string) => ({
        bind: (taskId: string) => ({
          all: async () => ({
            results:
              taskId === "task-2"
                ? query.includes("linked_at DESC")
                  ? [
                      {
                        repository: "Aragornnnnnn/landit-be",
                        pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/10",
                      },
                      {
                        repository: "Aragornnnnnn/landit-be",
                        pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
                      },
                    ]
                  : [
                      {
                        repository: "Aragornnnnnn/landit-be",
                        pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/11",
                      },
                      {
                        repository: "Aragornnnnnn/landit-be",
                        pr_url: "https://github.com/Aragornnnnnn/landit-be/pull/10",
                      },
                    ]
                : [],
          }),
          first: async () =>
            query.includes("expected_repositories")
              ? { expected_repositories: '["landit-be"]' }
              : null,
        }),
      }),
    } as unknown as D1Database;
    const client = new GitHubAppClient(database, { appId: "1", privateKey: "key" });
    vi.spyOn(client, "getPullRequest").mockImplementation(async (url) => ({
      repository: "Aragornnnnnn/landit-be",
      number: url.endsWith("/10") ? 10 : 11,
      url,
      headSha: "current",
      state: "open",
      review: "approved",
      ci: "passed",
    }));

    await expect(client.getTaskSnapshot("task-2")).resolves.toMatchObject({
      pullRequests: [expect.objectContaining({ number: 10 })],
    });
  });
});
