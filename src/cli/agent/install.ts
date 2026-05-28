// ── Agent install ─────────────────────────────────────────────

import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	rmSync,
	readdirSync,
	statSync,
	cpSync,
} from "fs";
import { join, resolve, basename, extname, dirname } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { loadAgentManifest, type AgentManifest } from "./manifest.js";
import { installExtension } from "../extend/install.js";

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
		// Auto-install missing extensions (uses full install flow with config)
		if (manifest?.extensionSources) {
			await autoInstallExtensions(manifest.extensionSources, projectRoot);
		}

		installLocal(absPath, name, projectRoot);
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

function installLocal(srcDir: string, name: string, projectRoot: string): void {
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

	// Seed built-in creation skills
	seedBuiltinSkills(agentDir);

	// Update .beluga/config.json
	const configPath = join(projectRoot, ".beluga", "config.json");
	if (existsSync(configPath)) {
		updateConfig(configPath, name);
	} else {
		console.warn("\nwarning: .beluga/config.json not found");
		console.warn("Run 'beluga onboard' first, then retry.");
	}
}

function updateConfig(configPath: string, name: string): void {
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

/**
 * Auto-install extensions listed in extensionSources.
 * Uses the full installExtension flow so config fields get populated
 * and required env vars are printed.
 */
async function autoInstallExtensions(
	sources: Record<string, string>,
	projectRoot: string,
): Promise<void> {
	const extDir = join(projectRoot, ".beluga", "extensions");
	const missing: string[] = [];

	console.log("\n━━ Installing extensions ━━━━━━━━━━━━━━━━━━━━━━━");

	for (const [extName, gitURL] of Object.entries(sources)) {
		const installed = existsSync(join(extDir, extName));
		if (installed) {
			console.log(`\n  extension '${extName}' already installed, skipping`);
			continue;
		}

		if (!gitURL) {
			console.warn(
				`  warning: no source URL for extension '${extName}', skipping`,
			);
			continue;
		}

		console.log(`\n  installing extension '${extName}' from ${gitURL}...`);
		try {
			await installExtension({
				source: gitURL,
				belugaDir: projectRoot,
			});
		} catch (err) {
			console.warn(`  ✗ failed to install extension '${extName}': ${err}`);
			missing.push(extName);
		}
	}

	if (missing.length > 0) {
		console.warn(
			`\nwarning: ${missing.length} extension(s) could not be auto-installed: ${missing.join(", ")}`,
		);
		console.warn("Install them manually with: beluga extend install <url>");
	}

	console.log("\n━━ Extensions complete ━━━━━━━━━━━━━━━━━━━━━━━━━");
}

// ── Built-in skills seeding ───────────────────────────────────

const BUILTIN_SKILLS = ["create-agent", "create-extension"];

/**
 * Seeds built-in creation skills into an agent's skills directory.
 * Skills are copied from src/cli/agent/skills/ so agents can create
 * other agents and extensions.
 */
function seedBuiltinSkills(agentDir: string): void {
	const skillsDir = join(agentDir, "skills");
	mkdirSync(skillsDir, { recursive: true });

	// Resolve the bundled skills directory relative to this file
	const thisDir = dirname(fileURLToPath(import.meta.url));
	const builtinDir = join(thisDir, "skills");

	if (!existsSync(builtinDir)) {
		return;
	}

	for (const skillName of BUILTIN_SKILLS) {
		const srcSkillDir = join(builtinDir, skillName);
		const destSkillDir = join(skillsDir, skillName);

		if (!existsSync(srcSkillDir)) continue;
		if (existsSync(destSkillDir)) continue; // Don't overwrite existing skills

		cpSync(srcSkillDir, destSkillDir, { recursive: true });
		console.log(`  seeded skill '${skillName}'`);
	}
}
