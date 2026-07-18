// GitHub Actions 검증 아티팩트의 스키마와 실행 문맥을 검증한다
import { z } from "zod";
import type { VerificationResult } from "../domain/verification-result";

const secretPattern =
  /AKIA[0-9A-Z]{16}|(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{10,}|\b(?:password|passwd|secret|token|api[_-]?key|aws_access_key_id|aws_secret_access_key)\s*[:=]\s*\S+/i;

const verificationCheckSchema = z
  .object({
    name: z.enum(["deployment", "ecs", "alb", "api", "sentry"]),
    status: z.enum(["passed", "failed", "unobservable", "skipped"]),
    evidenceUrl: z
      .url()
      .refine((value) => new URL(value).protocol === "https:")
      .optional(),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .refine((value) => !secretPattern.test(value)),
  })
  .strict();

const verificationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    taskId: z.string().trim().min(1).max(200),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    environment: z.enum(["develop", "prod"]),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/i),
    status: z.enum(["passed", "failed", "unobservable"]),
    checks: z.array(verificationCheckSchema).min(1).max(5),
    observedAt: z.string().refine((value) => {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
    }),
  })
  .strict()
  .superRefine((value, context) => {
    const names = value.checks.map((check) => check.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "duplicate check" });
    }
  });

export function parseVerificationArtifact(
  input: unknown,
  expected: {
    taskId: string;
    requestId: string;
    repository: string;
    environment: "develop" | "prod";
    commitSha: string;
    evidenceUrl: string;
  },
): VerificationResult {
  const parsed = verificationResultSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.taskId !== expected.taskId ||
    parsed.data.requestId !== expected.requestId ||
    parsed.data.repository.toLowerCase() !== expected.repository.toLowerCase() ||
    parsed.data.environment !== expected.environment ||
    parsed.data.commitSha.toLowerCase() !== expected.commitSha.toLowerCase()
  ) {
    throw new Error("VERIFICATION_ARTIFACT_INVALID");
  }
  if (
    parsed.data.checks.some(
      (check) => check.evidenceUrl && check.evidenceUrl !== expected.evidenceUrl,
    )
  ) {
    throw new Error("VERIFICATION_ARTIFACT_INVALID");
  }
  return parsed.data;
}

const requiredChecks = ["deployment", "ecs", "alb", "api"] as const;

export function deriveVerificationStatus(
  result: VerificationResult,
): "passed" | "failed" {
  if (result.status !== "passed") return "failed";
  const checksByName = new Map(result.checks.map((check) => [check.name, check]));
  for (const name of requiredChecks) {
    const check = checksByName.get(name);
    if (
      check?.status !== "passed" ||
      !check.evidenceUrl ||
      !check.evidenceUrl.startsWith("https://")
    ) {
      return "failed";
    }
  }
  return "passed";
}
