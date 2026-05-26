// ── Agent install ─────────────────────────────────────────────

import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	rmSync,
	readdirSync,
	statSync,
} from "fs";
import { join, resolve, basename, extname } from "path";
import { execSync } from "child_process";
import { loadAgentManifest, type AgentManifest } from "./manifest.js";

export interface AgentInstallConfig {
	source: string;
	type?: string;
	belugaDir?: string;
}

export async function installAgent(cfg: AgentInstallConfig): Promise<void> {
	const projectRoot = cfg.belugaDir ?? process.cwd();

	let absPath: string;
	let gitURL = "";

	if (isGitURL(cfg.source)) {
		gitURL = cfg.source;
		absPath = cloneAgent(cfg.source);
	} else {
		absPath = resolve(cfg.source);
		if (!existsSync(absPath)) {
			throw new Error(`agent directory ${absPath} does not exist`);
		}
	}

	const manifest = loadAgentManifest(absPath);
	const name = deriveName(manifest, gitURL, absPath);

	try {
		installLocal(absPath, name, projectRoot, manifest);
	} finally {
		if (gitURL) {
			try {
				rmSync(absPath, { recursive: true });
			} catch {
				// Temp cleanup best-effort
			}
		}
	}
}

function isGitURL(source: string): boolean {
	return (
		source.startsWith("https://github.com/") ||
		source.startsWith("git@github.com:") ||
		source.startsWith("https://gitlab.com/") ||
		source.endsWith(".git")
	);
}

function cloneAgent(gitURL: string): string {
	const tmpDir = join(process.cwd(), ".beluga", "tmp", `agent-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	execSync(`git clone ${gitURL} ${tmpDir}`, { stdio: "inherit" });
	return tmpDir;
}

function deriveName(
	manifest: AgentManifest | null,
	gitURL: string,
	absPath: string,
): string {
	if (manifest?.name) return manifest.name;
	if (gitURL) {
		const repo = basename(gitURL).replace(/\.git$/, "");
		if (repo) return repo;
	}
	return basename(absPath);
}

function installLocal(
	srcDir: string,
	name: string,
	projectRoot: string,
	manifest: AgentManifest | null,
): void {
	const agentDir = join(projectRoot, ".beluga", "agents", name);

	if (existsSync(agentDir)) {
		console.warn(`warning: agent directory already exists: ${agentDir}`);
		console.warn("removing and reinstalling...");
		rmSync(agentDir, { recursive: true });
	}

	mkdirSync(agentDir, { recursive: true });

	// Copy source files
	for (const entry of readdirSync(srcDir)) {
		const src = join(srcDir, entry);
		if (statSync(src).isDirectory()) continue;
		const ext = extname(entry).toLowerCase();
		if ([".ts", ".js", ".json", ".md"].includes(ext)) {
			writeFileSync(join(agentDir, entry), readFileSync(src));
		}
	}

	console.log(`agent copied to ${agentDir}`);

	// Update .beluga/config.json
	const configPath = join(projectRoot, ".beluga", "config.json");
	if (existsSync(configPath)) {
		updateConfig(configPath, name, manifest);
	} else {
		console.warn("\nwarning: .beluga/config.json not found");
		console.warn("Run 'beluga onboard' first, then retry.");
	}

	printPostInstall(name, manifest);
}

function updateConfig(
	configPath: string,
	name: string,
	manifest: AgentManifest | null,
): void {
	const raw = readFileSync(configPath, "utf-8");
	const config = JSON.parse(raw);

	if (!config.agents) config.agents = {};

	if (config.agents[name]) {
		console.log(`\nagent '${name}' already configured, skipping config update`);
		return;
	}

	config.agents[name] = { enabled: true };

	writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
	console.log(`\nupdated .beluga/config.json with '${name}' agent entry`);
}

function printPostInstall(name: string, manifest: AgentManifest | null): void {
	console.log(`\n✓ agent '${name}' installed successfully.`);

	console.log("\n━━ Next steps ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log(
		"  1. Edit .beluga/agents/" + name + "/SYSTEM.md to customize the agent",
	);
	console.log(
		"  2. Edit .beluga/agents/" +
			name +
			"/agent.json to set model, extensions, etc.",
	);
	console.log("  3. Add routing to .beluga/config.json:");
	console.log(
		`     "routing": { "${name}": "${name}", "_default": "default" }`,
	);
	console.log("  4. Restart Beluga:");
	console.log("       bun run src/main.ts start");
	console.log();
}
