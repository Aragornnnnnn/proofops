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

  it("아직 구현되지 않은 이슈 생성은 안전한 오류로 거부한다", async () => {
    const pages = createPages();
    const client = new NotionClient(pages, {
      token,
      databaseId: "database-id",
      statusProperty: "기술 상태",
    });

    await expect(
      client.createIssue({
        title: "새 이슈",
        description: "설명",
        acceptanceCriteria: [],
        repositories: [],
      }),
    ).rejects.toThrow("NOTION_CREATE_NOT_AVAILABLE");
    expect(pages.update).not.toHaveBeenCalled();
  });
});
