// Notion API 어댑터의 페이지 식별자 정규화와 제한된 상태 갱신을 검증한다
import { describe, expect, it, vi } from "vitest";
import { NotionClient } from "./client";

const pageId = "12345678-1234-1234-1234-1234567890ab";
const token = "secret-notion-token";

function createPages() {
  return {
    retrieve: vi.fn().mockResolvedValue({
      id: pageId,
      url: "https://www.notion.so/123456781234123412341234567890ab",
      properties: {
        이름: { type: "title", title: [{ plain_text: "ProofOps MVP" }] },
      },
    }),
    update: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({
      id: pageId,
      url: "https://www.notion.so/123456781234123412341234567890ab",
      properties: {
        Name: { type: "title", title: [{ plain_text: "새 이슈" }] },
      },
    }),
  };
}

describe("NotionClient", () => {
  it("Notion URL의 페이지 ID를 정규화해 이슈를 읽는다", async () => {
    const pages = createPages();
    const client = new NotionClient(pages, {
      token,
      databaseId: "database-id",
      statusProperty: "기술 상태",
    });

    await expect(
      client.getIssue("https://www.notion.so/landit/proofops-mvp-123456781234123412341234567890ab?pvs=4"),
    ).resolves.toMatchObject({ pageId, title: "ProofOps MVP" });
    expect(pages.retrieve).toHaveBeenCalledWith({ page_id: pageId });
  });

  it("설정된 기술 상태 속성만 Patch한다", async () => {
    const pages = createPages();
    const client = new NotionClient(pages, {
      token,
      databaseId: "database-id",
      statusProperty: "기술 상태",
    });

    await client.updateTechnicalStatus(pageId, "In Progress");

    expect(pages.update).toHaveBeenCalledWith({
      page_id: pageId,
      properties: { "기술 상태": { status: { name: "In Progress" } } },
    });
  });

  it("Notion 원문 오류에서 토큰, Authorization 헤더와 응답 본문을 제거한다", async () => {
    const pages = createPages();
    pages.retrieve.mockRejectedValue(
      new Error(`Authorization: Bearer ${token}; response: {"private":"value"}`),
    );
    const client = new NotionClient(pages, {
      token,
      databaseId: "database-id",
      statusProperty: "기술 상태",
    });

    await expect(client.getIssue(pageId)).rejects.toThrow("NOTION_READ_FAILED");
    await client.getIssue(pageId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(token);
      expect(message).not.toContain("Authorization");
      expect(message).not.toContain("private");
    });
  });

  it("명시된 이슈 입력을 고정된 본문 순서로 생성한다", async () => {
    const pages = createPages();
    const client = new NotionClient(pages, {
      token,
      databaseId: "database-id",
      statusProperty: "기술 상태",
    });

    await expect(
      client.createIssue({
        title: "새 이슈",
        impact: "사용자 목록을 조회할 수 없다.",
        evidence: [{ label: "Sentry issue", url: "https://sentry.io/issues/12345/" }],
        causeOrHypothesis: "Null 처리 누락으로 추정한다.",
        scope: ["API", "Web"],
        acceptanceCriteria: ["재현 테스트 추가"],
      }),
    ).resolves.toMatchObject({ pageId, title: "새 이슈" });
    expect(pages.create).toHaveBeenCalledWith({
      parent: { database_id: "database-id" },
      properties: {
        title: {
          title: [{ type: "text", text: { content: "새 이슈" } }],
        },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content:
                    "영향\n사용자 목록을 조회할 수 없다.\n\n근거 링크\n- Sentry issue: https://sentry.io/issues/12345/\n\n원인 또는 가설\nNull 처리 누락으로 추정한다.\n\n범위\n- API\n- Web\n\n완료 조건\n- 재현 테스트 추가",
                },
              },
            ],
          },
        },
      ],
    });
  });
});
