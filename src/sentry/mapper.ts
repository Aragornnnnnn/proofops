// Sentry 원문에서 최소 사건 근거를 민감정보 없이 정규화한다
export interface EvidenceLink {
  label: string;
  url: string;
}

export interface IncidentEvidence {
  issueId: string;
  title: string;
  culprit: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  count: number | null;
  affectedUsers: number | null;
  release: string | null;
  topStackFrames: StackFrame[];
  evidence: EvidenceLink[];
  observationLimit: string;
}

export interface StackFrame {
  filename: string | null;
  function: string | null;
  line: number | null;
  column: number | null;
}

interface SentryIssue {
  id?: unknown;
  title?: unknown;
  culprit?: unknown;
  firstSeen?: unknown;
  lastSeen?: unknown;
  count?: unknown;
  userCount?: unknown;
  permalink?: unknown;
  lastRelease?: { version?: unknown } | null;
  latestEvent?: {
    webUrl?: unknown;
    entries?: Array<{
      type?: unknown;
      data?: {
        values?: Array<{
          stacktrace?: { frames?: Array<RawStackFrame> } | null;
        }>;
      };
    }>;
  } | null;
}

interface RawStackFrame {
  filename?: unknown;
  function?: unknown;
  lineno?: unknown;
  colno?: unknown;
}

export function mapSentryIssue(rawIssue: unknown): IncidentEvidence {
  const issue = isSentryIssue(rawIssue) ? rawIssue : {};
  const issueUrl = sanitizeEvidenceText(issue.permalink);
  const eventUrl = sanitizeEvidenceText(issue.latestEvent?.webUrl);
  return {
    issueId: sanitizeEvidenceText(issue.id),
    title: sanitizeEvidenceText(issue.title),
    culprit: nullableEvidenceText(issue.culprit),
    firstSeen: nullableEvidenceText(issue.firstSeen),
    lastSeen: nullableEvidenceText(issue.lastSeen),
    count: numberOrNull(issue.count),
    affectedUsers: numberOrNull(issue.userCount),
    release: nullableEvidenceText(issue.lastRelease?.version),
    topStackFrames: topStackFrames(issue.latestEvent),
    evidence: [
      ...(issueUrl ? [{ label: "Sentry issue", url: issueUrl }] : []),
      ...(eventUrl ? [{ label: "Latest Sentry event", url: eventUrl }] : []),
    ],
    observationLimit:
      "Sentry issue metadata and the latest event were read; no root-cause conclusion was made.",
  };
}

function isSentryIssue(value: unknown): value is SentryIssue {
  return typeof value === "object" && value !== null;
}

function topStackFrames(event: SentryIssue["latestEvent"]): StackFrame[] {
  const frames = event?.entries
    ?.find((entry) => entry.type === "exception")
    ?.data?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? [];

  return frames
    .filter(
      (frame) =>
        nullableEvidenceText(frame.filename) || nullableEvidenceText(frame.function),
    )
    .slice(-2)
    .map((frame) => ({
      filename: nullableEvidenceText(frame.filename),
      function: nullableEvidenceText(frame.function),
      line: numberOrNull(frame.lineno),
      column: numberOrNull(frame.colno),
    }));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function sanitizeEvidenceText(value: unknown): string {
  return text(value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED]")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "[REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED]")
    .replace(/\b(?:cookie|session(?:id)?)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(
      /\b(?:api[-_]?key|access[-_]?token|access[-_]?key|key|token|secret|password)\s*[:=]\s*[^\s,;#&]+/gi,
      "[REDACTED]",
    )
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|access[-_]?key|key|token|secret|password)=)[^&#\s]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(#(?:api[-_]?key|access[-_]?token|access[-_]?key|key|token|secret|password)=)[^&#\s]*/gi,
      "$1[REDACTED]",
    )
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]")
    .trim()
    .slice(0, 500);
}

function nullableEvidenceText(value: unknown): string | null {
  const normalized = sanitizeEvidenceText(value);
  return normalized || null;
}

function numberOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}
