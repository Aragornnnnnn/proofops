// GitHub 리뷰 최신 상태 집계와 API 페이지네이션을 검증한다
import { describe, expect, it, vi } from "vitest";
import {
  collectGitHubPages,
  deriveCurrentReviewState,
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
