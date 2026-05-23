// Cross-platform replacement for `node --test test/*.test.js`.
//
// node 20 doesn't expand globs in --test, and quoting in package.json scripts
// breaks shell expansion on GitHub Actions' `bash -e {0}`. Listing the files
// in JS sidesteps both.

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(__dirname, "..", "test");

const files = (await readdir(testDir))
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join(testDir, f));

if (files.length === 0) {
  console.error("no test files found in", testDir);
  process.exit(1);
}

const args = ["--test", ...files];
const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
