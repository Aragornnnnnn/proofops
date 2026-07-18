// GitHub 리뷰 최신 상태 집계와 API 페이지네이션을 검증한다
import { describe, expect, it, vi } from "vitest";
import {
  collectGitHubPages,
  deriveCurrentReviewState,
  GitHubAppClient,
  type GitHubReview,
} from "./app-client";

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
});
