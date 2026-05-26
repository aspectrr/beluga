// ── Agent scaffold ────────────────────────────────────────────
// Creates a new agent directory with agent.json + SYSTEM.md.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

export interface AgentScaffoldConfig {
	name: string;
	from?: string;
	outDir: string;
}

export function scaffoldAgent(config: AgentScaffoldConfig): void {
	const dir = resolve(config.outDir, config.name);

	if (existsSync(dir)) {
		console.error(`directory already exists: ${dir}`);
		process.exit(1);
	}

	mkdirSync(dir, { recursive: true });

	// If --from is specified, copy the referenced agent's manifest as a template
	if (config.from) {
		scaffoldFromTemplate(config.name, config.from, dir);
	} else {
		scaffoldBlank(config.name, dir);
	}

	console.log(`\n✓ agent '${config.name}' scaffolded at ${dir}`);
}

function scaffoldBlank(name: string, dir: string): void {
	const manifest = {
		name,
		version: "0.1.0",
		description: `${name} agent for Beluga`,
		systemPrompt: "SYSTEM.md",
		extensions: [] as string[],
		config: [],
	};
	writeFileSync(
		join(dir, "agent.json"),
		JSON.stringify(manifest, null, 2) + "\n",
	);

	writeFileSync(
		join(dir, "SYSTEM.md"),
		`# ${name}

You are a specialized Beluga agent.
Edit this file to customize your behavior and personality.
`,
	);
}

function scaffoldFromTemplate(
	name: string,
	fromName: string,
	dir: string,
): void {
	// Try to load the source agent's manifest
	const fromDir = resolve(".beluga", "agents", fromName);
	const fromManifestPath = join(fromDir, "agent.json");

	if (!existsSync(fromManifestPath)) {
		console.warn(
			`source agent '${fromName}' not found at ${fromManifestPath}, creating blank agent`,
		);
		scaffoldBlank(name, dir);
		return;
	}

	const fromManifest = JSON.parse(readFileSync(fromManifestPath, "utf-8"));

	// Copy manifest but change the name
	const manifest = {
		...fromManifest,
		name,
		description: `${name} agent (based on ${fromName})`,
	};
	delete manifest.config; // Don't copy config values

	writeFileSync(
		join(dir, "agent.json"),
		JSON.stringify(manifest, null, 2) + "\n",
	);

	// Copy system prompt if it exists
	const promptFile = fromManifest.systemPrompt ?? "SYSTEM.md";
	const fromPromptPath = join(fromDir, promptFile);
	if (existsSync(fromPromptPath)) {
		const promptContent = readFileSync(fromPromptPath, "utf-8");
		writeFileSync(join(dir, "SYSTEM.md"), promptContent);
	} else {
		writeFileSync(
			join(dir, "SYSTEM.md"),
			`# ${name}\n\nYou are a specialized Beluga agent.\n`,
		);
	}

	console.log(`  (based on agent '${fromName}')`);
}
