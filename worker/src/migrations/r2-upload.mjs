#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

function usage() {
  console.error("Usage: node worker/src/migrations/r2-upload.mjs ./data/uploads uploads");
  console.error("       node worker/src/migrations/r2-upload.mjs ./data/reports reports");
  process.exit(1);
}

function walk(root) {
  const entries = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      entries.push(...walk(path));
    } else if (stat.isFile()) {
      entries.push(path);
    }
  }
  return entries;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const [sourceDirArg, prefixArg, bucketArg = "dailyreview-prod-assets"] = process.argv.slice(2);
if (!sourceDirArg || !prefixArg) usage();

const sourceDir = resolve(sourceDirArg);
if (!existsSync(sourceDir)) {
  console.error(`Source directory does not exist: ${sourceDir}`);
  process.exit(1);
}

const prefix = prefixArg.replace(/^\/+|\/+$/g, "");
const files = walk(sourceDir);
console.log(`Uploading ${files.length} files to R2 bucket ${bucketArg} with prefix ${prefix}`);

for (const file of files) {
  const relativePath = relative(sourceDir, file).split(sep).join("/");
  const key = `${prefix}/${relativePath}`;
  const command = ["npx", "wrangler", "r2", "object", "put", `${bucketArg}/${key}`, "--file", file];
  console.log(command.map(shellQuote).join(" "));
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
