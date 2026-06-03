// ── Agent scaffold ────────────────────────────────────────────
// Creates a new agent directory with agent.json + SYSTEM.md.

import { mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

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

	// Seed built-in creation skills
	seedBuiltinSkills(dir);
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

	// Clone system prompt from prompts/SYSTEM.md template if it exists
	const templatePath = resolve(".beluga", "prompts", "SYSTEM.md");
	if (existsSync(templatePath)) {
		const template = readFileSync(templatePath, "utf-8");
		writeFileSync(join(dir, "SYSTEM.md"), template);
		console.log(`  cloned prompts/SYSTEM.md → ${name}/SYSTEM.md`);
	} else {
		writeFileSync(
			join(dir, "SYSTEM.md"),
			`# ${name}\n\nYou are a specialized Beluga agent.\nEdit this file to customize your behavior and personality.\n`,
		);
	}
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

// ── Built-in skills seeding ───────────────────────────────────

const BUILTIN_SKILLS = ["create-agent", "create-extension"];

function seedBuiltinSkills(agentDir: string): void {
	const skillsDir = join(agentDir, "skills");
	mkdirSync(skillsDir, { recursive: true });

	const thisDir = dirname(fileURLToPath(import.meta.url));
	const builtinDir = join(thisDir, "skills");

	if (!existsSync(builtinDir)) return;

	for (const skillName of BUILTIN_SKILLS) {
		const srcSkillDir = join(builtinDir, skillName);
		const destSkillDir = join(skillsDir, skillName);

		if (!existsSync(srcSkillDir)) continue;
		if (existsSync(destSkillDir)) continue;

		cpSync(srcSkillDir, destSkillDir, { recursive: true });
		console.log(`  seeded skill '${skillName}'`);
	}
}
