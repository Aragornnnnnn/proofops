// Landit Notion 페이지를 ProofOps 이슈로 정규화하는 규칙을 검증한다
import { describe, expect, it } from "vitest";
import { mapNotionPage } from "./mapper";

const pageId = "12345678-1234-1234-1234-1234567890ab";

describe("mapNotionPage", () => {
  it("Landit 이슈에서 제목, 요구사항, 완료 조건, 저장소와 기술 상태를 읽는다", () => {
    expect(
      mapNotionPage(
        {
          id: pageId,
          url: "https://www.notion.so/landit/proofops-mvp-123456781234123412341234567890ab",
          properties: {
            이름: { type: "title", title: [{ plain_text: "ProofOps MVP" }] },
            설명: {
              type: "rich_text",
              rich_text: [{ plain_text: "Notion 작업 상태를 자동으로 반영한다." }],
            },
            "완료 조건": {
              type: "rich_text",
              rich_text: [{ plain_text: "상태를 갱신한다\n토큰을 노출하지 않는다" }],
            },
            저장소: {
              type: "multi_select",
              multi_select: [{ name: "landit/landit-be" }, { name: "landit/landit-ai" }],
            },
            "기술 상태": { type: "status", status: { name: "In Review" } },
          },
        },
        { statusProperty: "기술 상태" },
      ),
    ).toEqual({
      pageId,
      url: "https://www.notion.so/landit/proofops-mvp-123456781234123412341234567890ab",
      title: "ProofOps MVP",
      description: "Notion 작업 상태를 자동으로 반영한다.",
      acceptanceCriteria: ["상태를 갱신한다", "토큰을 노출하지 않는다"],
      repositories: ["landit/landit-be", "landit/landit-ai"],
      currentTechnicalStatus: "In Review",
    });
  });

  it("누락된 선택 속성을 빈 값으로 정규화한다", () => {
    expect(
      mapNotionPage(
        {
          id: pageId,
          url: "https://www.notion.so/123456781234123412341234567890ab",
          properties: {
            이름: { type: "title", title: [{ plain_text: "최소 이슈" }] },
          },
        },
        { statusProperty: "기술 상태" },
      ),
    ).toMatchObject({
      title: "최소 이슈",
      description: "",
      acceptanceCriteria: [],
      repositories: [],
      currentTechnicalStatus: null,
    });
  });
});
