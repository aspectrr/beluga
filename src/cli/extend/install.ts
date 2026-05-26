// ── Extension install ─────────────────────────────────────────

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
import { loadManifest, type Manifest } from "./manifest.js";

export interface InstallConfig {
	source: string;
	type?: string;
	belugaDir?: string;
}

export async function installExtension(cfg: InstallConfig): Promise<void> {
	const projectRoot = cfg.belugaDir ?? process.cwd();

	let absPath: string;
	let gitURL = "";

	if (isGitURL(cfg.source)) {
		gitURL = cfg.source;
		absPath = cloneExtension(cfg.source);
	} else {
		absPath = resolve(cfg.source);
		if (!existsSync(absPath)) {
			throw new Error(`extension directory ${absPath} does not exist`);
		}
	}

	const manifest = loadManifest(absPath);
	const name = deriveName(manifest, gitURL, absPath);

	// Install dependencies first (before we clean up tmp dir)
	if (manifest?.dependencies && manifest.dependencies.length > 0) {
		await installDependencies(manifest.dependencies, projectRoot);
	}

	try {
		installLocal(absPath, name, projectRoot, manifest);
	} finally {
		if (gitURL) {
			try {
				rmSync(absPath, { recursive: true });
			} catch (_e) {
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

function cloneExtension(gitURL: string): string {
	const tmpDir = join(process.cwd(), ".beluga", "tmp", `ext-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	execSync(`git clone ${gitURL} ${tmpDir}`, { stdio: "inherit" });
	return tmpDir;
}

function deriveName(
	manifest: Manifest | null,
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
	manifest: Manifest | null,
): void {
	const extDir = join(projectRoot, ".beluga", "extensions", name);

	if (existsSync(extDir)) {
		console.warn(`warning: extension directory already exists: ${extDir}`);
		console.warn("removing and reinstalling...");
		rmSync(extDir, { recursive: true });
	}

	mkdirSync(extDir, { recursive: true });

	// Copy source files
	for (const entry of readdirSync(srcDir)) {
		const src = join(srcDir, entry);
		if (statSync(src).isDirectory()) continue;
		const ext = extname(entry).toLowerCase();
		if ([".ts", ".js", ".json", ".md"].includes(ext)) {
			writeFileSync(join(extDir, entry), readFileSync(src));
		}
	}

	console.log(`extension copied to ${extDir}`);

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
	manifest: Manifest | null,
): void {
	const raw = readFileSync(configPath, "utf-8");
	const config = JSON.parse(raw);

	if (config.extensions?.[name]) {
		console.log(
			`\nextension '${name}' already configured, skipping config update`,
		);
		return;
	}

	// Backup
	backupFile(configPath);

	// Build extension config entry
	if (!config.extensions) config.extensions = {};
	config.extensions[name] = buildExtensionConfig(manifest);

	writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
	console.log(`\nupdated .beluga/config.json with '${name}' extension config`);
}

function buildExtensionConfig(
	manifest: Manifest | null,
): Record<string, unknown> {
	const entry: Record<string, unknown> = { enabled: true };

	if (manifest?.config && manifest.config.length > 0) {
		for (const f of manifest.config) {
			if (f.default) {
				entry[f.name] = f.default;
			} else if (f.secret && f.env_var) {
				entry[f.name] = `\${${f.env_var}}`;
			} else if (f.required) {
				entry[f.name] = "REQUIRED";
			} else {
				entry[f.name] = null;
			}
		}
	}

	return entry;
}

// ── Dependency resolution ──────────────────────────────────────

async function installDependencies(
	deps: Array<{ name: string; source: string }>,
	projectRoot: string,
): Promise<void> {
	const extDir = join(projectRoot, ".beluga", "extensions");

	for (const dep of deps) {
		if (existsSync(join(extDir, dep.name))) {
			console.log(`  dependency '${dep.name}' already installed, skipping`);
			continue;
		}

		console.log(`  installing dependency '${dep.name}' from ${dep.source}...`);
		await installExtension({
			source: dep.source,
			belugaDir: projectRoot,
		});
		console.log(`  ✓ dependency '${dep.name}' installed`);
	}
}

function backupFile(path: string): void {
	const ext = extname(path);
	const base = path.slice(0, -ext.length || Infinity);

	for (let i = 1; i < 100; i++) {
		const candidate = `${base}.bak${i}${ext}`;
		if (!existsSync(candidate)) {
			writeFileSync(candidate, readFileSync(path));
			return;
		}
	}
	throw new Error("too many backup files (over 99)");
}

function printPostInstall(name: string, manifest: Manifest | null): void {
	console.log(`\n✓ extension '${name}' installed successfully.`);

	if (!manifest?.config?.length) {
		console.log(
			"\nNo config fields declared. Edit .beluga/config.json to enable.",
		);
		return;
	}

	const required = manifest.config.filter((f) => f.required);
	const optional = manifest.config.filter((f) => !f.required);

	if (required.length) {
		console.log("\n━━ Required config ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		for (const f of required) {
			console.log(`\n  ${f.name}${f.type ? ` (${f.type})` : ""}`);
			console.log(`    ${f.description}`);
			if (f.env_var)
				console.log(`    Set env var: export ${f.env_var}=<your-value>`);
			if (f.default) console.log(`    Default: ${f.default}`);
		}
	}

	if (optional.length) {
		console.log("\n━━ Optional config ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		for (const f of optional) {
			const desc =
				f.description + (f.default ? ` (default: ${f.default})` : "");
			console.log(`  ${f.name}: ${desc}`);
		}
	}

	console.log("\n━━ Next steps ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log("  1. Edit .beluga/config.json to set required values");
	console.log("  2. Restart Beluga:");
	console.log("       bun run src/main.ts start");
	console.log();
}
