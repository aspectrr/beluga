// ── Agent remove ──────────────────────────────────────────────
// Removes an installed agent and cleans up config.

import { rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

export function removeAgent(name: string, belugaDir?: string): void {
	const projectRoot = belugaDir ?? process.cwd();
	const agentDir = resolve(projectRoot, ".beluga", "agents", name);

	if (!existsSync(agentDir)) {
		console.error(`agent '${name}' not found at ${agentDir}`);
		process.exit(1);
	}

	// Remove agent directory
	rmSync(agentDir, { recursive: true });
	console.log(`removed agent directory: ${agentDir}`);

	// Clean up config.json
	const configPath = resolve(projectRoot, ".beluga", "config.json");
	if (existsSync(configPath)) {
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw);
		let changed = false;

		// Remove agent entry
		if (config.agents?.[name]) {
			delete config.agents[name];
			changed = true;
			console.log(`removed '${name}' from agents config`);
		}

		// Remove routing entries pointing to this agent
		if (config.routing) {
			const routesToRemove = Object.entries(config.routing)
				.filter(([, target]) => target === name)
				.map(([source]) => source);

			for (const source of routesToRemove) {
				delete config.routing[source];
				console.log(`removed routing: ${source} → ${name}`);
			}

			if (routesToRemove.length > 0) changed = true;
		}

		if (changed) {
			writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
			console.log(`updated .beluga/config.json`);
		}
	}

	console.log(`\nagent '${name}' removed`);
}
