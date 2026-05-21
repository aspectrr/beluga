// ── Extension verify ──────────────────────────────────────────
// Ported from internal/cli/extend/verify.go

import { existsSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { loadManifest } from "./manifest.js";

export interface ToolCheck {
	name: string;
	schemaValid: "passed" | "failed" | "skipped";
	dryRun: "passed" | "failed" | "skipped";
}

export interface VerifyResult {
	compiles: boolean;
	testsPass: boolean;
	tools: ToolCheck[];
	errors: string[];
}

export async function verifyExtension(path: string): Promise<VerifyResult> {
	const dir = resolve(path);
	const errors: string[] = [];
	let compiles = false;
	let testsPass = false;
	const tools: ToolCheck[] = [];

	// Check manifest
	const manifest = loadManifest(dir);
	if (!manifest) {
		errors.push("no extension.json found");
	}

	// Check entry point exists
	const entrypoint = manifest?.entrypoint ?? "index.ts";
	if (!existsSync(join(dir, entrypoint))) {
		errors.push(`entrypoint not found: ${entrypoint}`);
	} else {
		// Try to type-check
		try {
			execSync(`bun build ${join(dir, entrypoint)} --no-bundle`, {
				stdio: "pipe",
				cwd: dir,
			});
			compiles = true;
		} catch (err) {
			errors.push("type check failed");
			compiles = false;
		}
	}

	// Run tests if present
	if (
		existsSync(join(dir, "__tests__")) ||
		existsSync(join(dir, "index.test.ts"))
	) {
		try {
			execSync("bun test", { stdio: "pipe", cwd: dir });
			testsPass = true;
		} catch {
			errors.push("tests failed");
			testsPass = false;
		}
	} else {
		testsPass = true; // No tests = pass
	}

	return { compiles, testsPass, tools, errors };
}

export function printVerifyResult(result: VerifyResult): void {
	console.log("\n━━ Extension Verification ━━━━━━━━━━━━━━━━━━━━━━");
	console.log(`  Compiles:  ${result.compiles ? "✓" : "✗"}`);
	console.log(`  Tests:     ${result.testsPass ? "✓" : "✗"}`);

	if (result.errors.length > 0) {
		console.log("\n  Errors:");
		for (const err of result.errors) {
			console.log(`    • ${err}`);
		}
	}

	if (result.tools.length > 0) {
		console.log("\n  Tools:");
		for (const tool of result.tools) {
			console.log(
				`    • ${tool.name}: schema=${tool.schemaValid} dry_run=${tool.dryRun}`,
			);
		}
	}

	console.log();
}
