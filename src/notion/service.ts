// ProofOps가 사용하는 Notion 이슈 읽기와 상태 갱신 포트를 정의한다
import type { TechnicalStatus } from "../domain/types";

export interface NotionIssue {
  pageId: string;
  url: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  repositories: string[];
  currentTechnicalStatus: string | null;
}

export interface CreateIssueInput {
  title: string;
  impact: string;
  evidence: EvidenceLink[];
  causeOrHypothesis: string;
  scope: string[];
  acceptanceCriteria: string[];
}

export interface EvidenceLink {
  label: string;
  url: string;
}

export interface NotionPort {
  getIssue(pageIdOrUrl: string): Promise<NotionIssue>;
  updateTechnicalStatus(pageId: string, status: string): Promise<void>;
  createIssue(input: CreateIssueInput): Promise<NotionIssue>;
}
