// ProofOps MCP 도구의 입력과 출력 형식을 검증한다
import { z } from "zod";

const technicalStatusSchema = z.enum([
  "In Progress",
  "In Review",
  "Changes Requested",
  "Blocked",
  "Deploying",
  "Verifying",
  "Done",
  "Failed",
]);

const operationIdSchema = z.uuid();

export const startTaskInputSchema = z.object({
  operationId: operationIdSchema,
  notionPageIdOrUrl: z.string().trim().min(1),
});

export const linkPullRequestInputSchema = z.object({
  operationId: operationIdSchema,
  taskId: z.string().trim().min(1),
  pullRequestUrl: z.url().refine((value) => value.startsWith("https://github.com/")),
});

export const getTaskStatusInputSchema = z.object({
  taskId: z.string().trim().min(1),
});

export const recordProgressInputSchema = z.object({
  taskId: z.string().trim().min(1),
  kind: z.enum(["test", "blocker", "decision"]),
  summary: z.string().trim().min(1).max(1_000),
  evidenceUrl: z
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "evidenceUrl must use http or https")
    .optional(),
});

export const requestVerificationInputSchema = z.object({
  operationId: operationIdSchema,
  taskId: z.string().trim().min(1).max(200),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  environment: z.enum(["develop", "prod"]),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/i),
});

const evidenceLinkSchema = z.object({
  label: z.string().trim().min(1).max(200),
  url: z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "evidence URL must use http or https"),
});

export const investigateIncidentInputSchema = z.object({
  sentryIssueUrlOrId: z.string().trim().min(1).max(2_000),
});

export const createNotionIssueInputSchema = z.object({
  operationId: operationIdSchema,
  title: z.string().trim().min(1).max(200),
  impact: z.string().trim().min(1).max(4_000),
  evidence: z.array(evidenceLinkSchema).min(1).max(20),
  causeOrHypothesis: z.string().trim().min(1).max(4_000),
  scope: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(50),
});

export const taskContextSchema = z.object({
  id: z.string(),
  notionPageId: z.string(),
  notionUrl: z.string(),
  title: z.string(),
  technicalStatus: technicalStatusSchema,
  expectedRepositories: z.array(z.string()),
  missingRepositories: z.array(z.string()),
  lastSyncError: z.string().nullable(),
});

export const progressNoteSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(["test", "blocker", "decision"]),
  summary: z.string(),
  evidenceUrl: z.string().nullable(),
  createdAt: z.string(),
});

export const verificationDispatchSchema = z.object({
  requestId: z.string().uuid(),
  workflowRunUrl: z.string().url(),
  status: z.string(),
});

export const incidentEvidenceSchema = z.object({
  issueId: z.string(),
  title: z.string(),
  culprit: z.string().nullable(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  count: z.number().nullable(),
  affectedUsers: z.number().nullable(),
  release: z.string().nullable(),
  topStackFrames: z.array(
    z.object({
      filename: z.string().nullable(),
      function: z.string().nullable(),
      line: z.number().nullable(),
      column: z.number().nullable(),
    }),
  ),
  evidence: z.array(evidenceLinkSchema),
  observationLimit: z.string(),
});

export const notionIssueSchema = z.object({
  pageId: z.string(),
  url: z.string().url(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  repositories: z.array(z.string()),
  currentTechnicalStatus: z.string().nullable(),
});
