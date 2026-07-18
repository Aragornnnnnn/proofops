// 클라이언트 예시와 운영 문서의 링크 및 비밀값 패턴을 검사한다
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "clients/codex/config.toml.example",
  "clients/claude/.mcp.json.example",
  "docs/setup.md",
  "docs/github-app.md",
  "docs/notion.md",
  "docs/operations.md",
];
const forbidden = [
  /TO[D]O|TB[D]|FIX[M]E/,
  /BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/,
  /secret_[A-Za-z0-9]+/,
];
const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

let failed = false;
for (const file of files) {
  const text = await readFile(resolve(root, file), "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      console.error(`${file}: forbidden pattern ${pattern}`);
      failed = true;
    }
  }
  if (!file.endsWith(".md")) continue;
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    try {
      await readFile(resolve(dirname(resolve(root, file)), target));
    } catch {
      console.error(`${file}: broken relative link ${target}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
