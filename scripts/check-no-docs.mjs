import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const forbidden = resolve(packageRoot, "docs");

if (existsSync(forbidden)) {
  console.error(`禁止在开源发布包中包含 docs/：${forbidden}`);
  process.exit(1);
}

const maintainedDocuments = ["AI-DEPLOYMENT.md", "CONFIGURATION.md", "README.md", "CHANGELOG.md"];
const staleReferences = [
  "AGENTS.md",
  "SOURCE-PROVENANCE.md",
  "DEPLOYMENT-MANIFEST.json",
  "scripts/pull-cf2-artifact.mjs",
  "scripts/probe-large-image.mjs",
  "MODEL-RESEARCH.md",
  "reports/CF2-",
];
for (const document of maintainedDocuments) {
  const text = readFileSync(resolve(packageRoot, document), "utf8");
  for (const reference of staleReferences) {
    if (text.includes(reference)) {
      console.error(`${document} 引用了发布包中不存在的路径：${reference}`);
      process.exit(1);
    }
  }
}

console.log("发布包目录检查通过：不存在 docs/ 或已知失效本地路径引用");
