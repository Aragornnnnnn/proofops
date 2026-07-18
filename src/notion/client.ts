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
      return mapNotionPage(page as NotionPage, {
        statusProperty: this.config.statusProperty,
      });
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

  async createIssue(input: CreateIssueInput): Promise<NotionIssue> {
    try {
      const page = await this.pages.create({
        parent: { database_id: this.config.databaseId },
        properties: {
          title: {
            title: [{ type: "text", text: { content: input.title } }],
          },
        },
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: formatIssueBody(input) } }],
            },
          },
        ],
      });
      return mapNotionPage(page as NotionPage, {
        statusProperty: this.config.statusProperty,
      });
    } catch {
      throw new Error("NOTION_CREATE_FAILED");
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
    },
    {
      token: env.NOTION_TOKEN,
      databaseId: env.NOTION_ISSUE_DATABASE_ID,
      statusProperty: env.NOTION_STATUS_PROPERTY,
    },
  );
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
