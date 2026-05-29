// ── Agent verify ──────────────────────────────────────────────
// Validates an agent directory structure.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { loadAgentManifest } from "./manifest.js";

export interface AgentVerifyResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export async function verifyAgent(path: string): Promise<AgentVerifyResult> {
	const dir = resolve(path);
	const errors: string[] = [];
	const warnings: string[] = [];

	// Check agent.json exists
	const manifest = loadAgentManifest(dir);
	if (!manifest) {
		errors.push("no agent.json found");
		return { valid: false, errors, warnings };
	}

	// Required fields
	if (!manifest.name) {
		errors.push("agent.json missing required 'name' field");
	}

	if (!manifest.systemPrompt) {
		errors.push("agent.json missing required 'systemPrompt' field");
	}

	// Check system prompt file exists
	if (manifest.systemPrompt) {
		const promptPath = join(dir, manifest.systemPrompt);
		if (!existsSync(promptPath)) {
			errors.push(`system prompt file not found: ${manifest.systemPrompt}`);
		}
	}

	// Check referenced extensions exist
	if (manifest.extensions && manifest.extensions.length > 0) {
		for (const extName of manifest.extensions) {
			const extDir = resolve(".beluga", "extensions", extName);
			if (!existsSync(extDir)) {
				warnings.push(
					`referenced extension '${extName}' not found at .beluga/extensions/${extName}`,
				);
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

export function printAgentVerifyResult(
	name: string,
	result: AgentVerifyResult,
): void {
	console.log(`\n━━ Agent Verification: ${name} ━━━━━━━━━━━━━━━━━━━`);
	console.log(`  Valid: ${result.valid ? "✓" : "✗"}`);

	if (result.errors.length > 0) {
		console.log("\n  Errors:");
		for (const err of result.errors) {
			console.log(`    • ${err}`);
		}
	}

	if (result.warnings.length > 0) {
		console.log("\n  Warnings:");
		for (const warn of result.warnings) {
			console.log(`    ⚠ ${warn}`);
		}
	}

	console.log();
}
