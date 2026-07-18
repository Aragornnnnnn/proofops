// Notion 페이지 속성을 ProofOps 이슈 컨텍스트로 정규화한다
import type { NotionIssue } from "./service";

export interface NotionProperty {
  type: string;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  multi_select?: Array<{ name?: string }>;
  status?: { name?: string | null } | null;
}

export interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, NotionProperty>;
}

export interface NotionMapperOptions {
  statusProperty: string;
}

export function mapNotionPage(
  page: NotionPage,
  options: NotionMapperOptions,
): NotionIssue {
  const properties = page.properties;
  const title = Object.values(properties).find((property) => property.type === "title");
  const acceptanceCriteria = text(properties["완료 조건"])
    .split("\n")
    .map((criterion) => criterion.trim())
    .filter(Boolean);

  return {
    pageId: page.id,
    url: page.url,
    title: text(title),
    description: text(properties.설명),
    acceptanceCriteria,
    repositories: properties.저장소?.multi_select?.flatMap((option) =>
      option.name ? [option.name] : [],
    ) ?? [],
    currentTechnicalStatus: properties[options.statusProperty]?.status?.name ?? null,
  };
}

function text(property: NotionProperty | undefined): string {
  if (!property) return "";
  const values = property.title ?? property.rich_text ?? [];
  return values.flatMap((value) => (value.plain_text ? [value.plain_text] : [])).join("");
}
