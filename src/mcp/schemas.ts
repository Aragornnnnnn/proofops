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

export const startTaskInputSchema = z.object({
  notionPageIdOrUrl: z.string().trim().min(1),
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
