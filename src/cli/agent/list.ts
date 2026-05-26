// ── Agent list ────────────────────────────────────────────────
// Lists installed agents and their status.

import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

export function listAgents(belugaDir?: string): void {
	const projectRoot = belugaDir ?? process.cwd();
	const agentsDir = resolve(projectRoot, ".beluga", "agents");

	if (!existsSync(agentsDir)) {
		console.log("No agents directory found. Run 'beluga onboard' first.");
		return;
	}

	// Load config for enabled status + routing
	const configPath = resolve(projectRoot, ".beluga", "config.json");
	let config: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		config = JSON.parse(readFileSync(configPath, "utf-8"));
	}

	const agents = config.agents as
		| Record<string, { enabled?: boolean }>
		| undefined;
	const routing = config.routing as Record<string, string> | undefined;

	// Scan agent directories
	const entries = readdirSync(agentsDir).filter((entry) => {
		const fullPath = join(agentsDir, entry);
		return statSync(fullPath).isDirectory();
	});

	if (entries.length === 0) {
		console.log("No agents installed.");
		return;
	}

	console.log("\n━━ Installed Agents ━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

	for (const name of entries.sort()) {
		const agentDir = join(agentsDir, name);
		const manifestPath = join(agentDir, "agent.json");

		let description = "";
		let extensions: string[] = [];

		if (existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
				description = manifest.description ?? "";
				extensions = manifest.extensions ?? [];
			} catch {
				description = "(invalid agent.json)";
			}
		}

		const enabled = agents?.[name]?.enabled !== false;
		const routes = findRoutes(routing ?? {}, name);

		console.log(
			`  ${enabled ? "●" : "○"} ${name}${description ? ` — ${description}` : ""}`,
		);
		if (extensions.length > 0) {
			console.log(`    extensions: ${extensions.join(", ")}`);
		}
		if (routes.length > 0) {
			console.log(`    routing: ${routes.join(", ")}`);
		}
		console.log();
	}

	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log();
}

function findRoutes(
	routing: Record<string, string>,
	agentName: string,
): string[] {
	const routes: string[] = [];
	for (const [source, target] of Object.entries(routing)) {
		if (target === agentName) {
			routes.push(source);
		}
	}
	return routes;
}
