import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const forbidden = resolve(packageRoot, "docs");

if (existsSync(forbidden)) {
  console.error(`禁止在开源发布包中包含 docs/：${forbidden}`);
  process.exit(1);
}

console.log("发布包目录检查通过：不存在 docs/");
