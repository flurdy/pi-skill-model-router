import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
assert.ok(packageJson.keywords.includes("pi-package"), "package is missing the pi-package discovery keyword");
assert.deepEqual(packageJson.pi, { extensions: ["./index.ts"] });

const allowedPackageFiles = [
	"README.md",
	"config.ts",
	"index.ts",
	"model-tier-router.example.json",
	"model-tier-router.opinionated.example.json",
	"routing.ts",
	"usage-ledger.ts",
	"usage.ts",
];
assert.deepEqual([...packageJson.files].sort(), allowedPackageFiles, "package files must remain an exact allowlist");

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
	cwd: repositoryRoot,
	encoding: "utf8",
});
const report = JSON.parse(output);
assert.equal(report.length, 1, "expected one npm pack report");

const files = report[0].files.map((entry) => entry.path).sort();
const expectedFiles = ["LICENSE", "package.json", ...allowedPackageFiles].sort();
assert.deepEqual(files, expectedFiles, "npm package contents differ from the exact allowlist");

console.log(`Package allowlist verified (${files.length} files).`);
