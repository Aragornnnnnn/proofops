// Notion API 호출을 안전한 ProofOps 이슈 포트로 변환한다
import { Client as NotionApiClient } from "@notionhq/client";
import type { Env } from "../env";
import { mapNotionPage, type NotionPage } from "./mapper";
import type { CreateIssueInput, NotionIssue, NotionPort } from "./service";

export interface NotionPagesApi {
  retrieve(args: { page_id: string }): Promise<unknown>;
  update(args: {
    page_id: string;
    properties: Record<string, { status: { name: string } }>;
  }): Promise<unknown>;
  create(args: {
    parent: { database_id: string };
    properties: Record<string, unknown>;
    children: Array<Record<string, unknown>>;
  }): Promise<unknown>;
  search(args: {
    query: string;
    filter: { property: "object"; value: "page" };
    page_size: number;
    start_cursor?: string;
  }): Promise<unknown>;
}

export interface NotionClientConfig {
  token: string;
  databaseId: string;
  statusProperty: string;
}

export class NotionClient implements NotionPort {
  constructor(
    private readonly pages: NotionPagesApi,
    private readonly config: NotionClientConfig,
  ) {}

  async getIssue(pageIdOrUrl: string): Promise<NotionIssue> {
    const pageId = normalizePageId(pageIdOrUrl);
    try {
      const page = await this.pages.retrieve({ page_id: pageId });
      const issue = mapNotionPage(page as NotionPage, {
        statusProperty: this.config.statusProperty,
      });
      return { ...issue, title: stripOperationMarker(issue.title) };
    } catch {
      throw new Error("NOTION_READ_FAILED");
    }
  }

  async updateTechnicalStatus(pageId: string, status: string): Promise<void> {
    try {
      await this.pages.update({
        page_id: normalizePageId(pageId),
        properties: {
          [this.config.statusProperty]: { status: { name: status } },
        },
      });
    } catch {
      throw new Error("NOTION_STATUS_UPDATE_FAILED");
    }
  }

  async createIssue(input: CreateIssueInput, operationId?: string): Promise<NotionIssue> {
    try {
      const marker = operationId ? operationMarker(operationId) : null;
      const page = await this.pages.create({
        parent: { database_id: this.config.databaseId },
        properties: {
          title: {
            title: [
              {
                type: "text",
                text: { content: marker ? `${input.title} [${marker}]` : input.title },
              },
            ],
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
                    content: marker
                      ? `${formatIssueBody(input)}\n\n${marker}`
                      : formatIssueBody(input),
                  },
                },
              ],
            },
          },
        ],
      });
      const issue = mapNotionPage(page as NotionPage, {
        statusProperty: this.config.statusProperty,
      });
      return marker ? { ...issue, title: input.title } : issue;
    } catch {
      throw new Error("NOTION_CREATE_FAILED");
    }
  }

  async findIssueByOperationMarker(operationId: string): Promise<NotionIssue | null> {
    const marker = operationMarker(operationId);
    let cursor: string | undefined;
    try {
      do {
        const response = (await this.pages.search({
          query: marker,
          filter: { property: "object", value: "page" },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        })) as { results?: unknown[]; has_more?: boolean; next_cursor?: string | null };
        for (const result of response.results ?? []) {
          if (!belongsToConfiguredDatabase(result, this.config.databaseId)) continue;
          try {
            const issue = mapNotionPage(result as NotionPage, {
              statusProperty: this.config.statusProperty,
            });
            if (issue.title.includes(`[${marker}]`)) {
              return { ...issue, title: stripOperationMarker(issue.title) };
            }
          } catch {
            // 부분 검색 결과는 marker 존재 증거로 사용하지 않는다.
          }
        }
        cursor = response.has_more && response.next_cursor
          ? response.next_cursor
          : undefined;
      } while (cursor);
      return null;
    } catch {
      throw new Error("NOTION_RECONCILIATION_FAILED");
    }
  }
}

export function createNotionClient(env: Pick<Env, "NOTION_TOKEN" | "NOTION_ISSUE_DATABASE_ID" | "NOTION_STATUS_PROPERTY">): NotionClient {
  const client = new NotionApiClient({ auth: env.NOTION_TOKEN });
  return new NotionClient(
    {
      retrieve: (args) => client.pages.retrieve(args),
      update: (args) =>
        client.pages.update(args as Parameters<typeof client.pages.update>[0]),
      create: (args) =>
        client.pages.create(args as Parameters<typeof client.pages.create>[0]),
      search: (args) => client.search(args),
    },
    {
      token: env.NOTION_TOKEN,
      databaseId: env.NOTION_ISSUE_DATABASE_ID,
      statusProperty: env.NOTION_STATUS_PROPERTY,
    },
  );
}

function operationMarker(operationId: string): string {
  return `ProofOps operation: ${operationId}`;
}

function stripOperationMarker(title: string): string {
  return title.replace(
    / \[ProofOps operation: [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\]$/i,
    "",
  );
}

function belongsToConfiguredDatabase(value: unknown, databaseId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const parent = (value as { parent?: unknown }).parent;
  if (!parent || typeof parent !== "object") return false;
  const candidate = parent as { database_id?: unknown; data_source_id?: unknown };
  return candidate.database_id === databaseId || candidate.data_source_id === databaseId;
}

function formatIssueBody(input: CreateIssueInput): string {
  return [
    "영향",
    input.impact,
    "",
    "근거 링크",
    ...input.evidence.map((link) => `- ${link.label}: ${link.url}`),
    "",
    "원인 또는 가설",
    input.causeOrHypothesis,
    "",
    "범위",
    ...input.scope.map((item) => `- ${item}`),
    "",
    "완료 조건",
    ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].join("\n");
}

export function normalizePageId(pageIdOrUrl: string): string {
  const match = pageIdOrUrl.match(
    /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32}/i,
  );
  if (!match) throw new Error("INPUT_INVALID");

  const compact = match[0].replaceAll("-", "").toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}
