// ── Workspace image builder ─────────────────────────────────
// Merges workspace requirements from all enabled extensions,
// generates a Dockerfile layer on top of the base workspace image,
// and builds the composed image.

import { readdir, stat, readFile, writeFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import type { Logger } from "pino";
import { spawn } from "child_process";
import { createHash } from "crypto";
import type { WorkspaceRequirements } from "@aspectrr/beluga-sdk";

export interface WorkspaceBuildConfig {
	/** Path to .beluga/ directory */
	belugaDir: string;
	/** Base image name (default: beluga/agent-workspace:latest) */
	baseImage: string;
	/** Output image name (default: beluga/agent-workspace:latest) */
	outputImage: string;
	/** Path to the base workspace.Dockerfile */
	baseDockerfile: string;
}

/** Fingerprint merged requirements to skip unchanged builds. */
function fingerprint(reqs: WorkspaceRequirements): string {
	const normalized = JSON.stringify(reqs, Object.keys(reqs).sort());
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Read extension.json manifests and merge workspace requirements. */
async function mergeRequirements(
	extensionsDir: string,
	logger: Logger,
): Promise<WorkspaceRequirements> {
	const merged: WorkspaceRequirements = {};

	let entries: string[];
	try {
		entries = await readdir(extensionsDir);
	} catch {
		logger.debug({ dir: extensionsDir }, "no extensions directory");
		return merged;
	}

	for (const entry of entries) {
		const extPath = join(extensionsDir, entry);
		const extStat = await stat(extPath);
		if (!extStat.isDirectory()) continue;

		const manifestPath = join(extPath, "extension.json");
		try {
			const data = await readFile(manifestPath, "utf-8");
			const manifest = JSON.parse(data);

			if (manifest.workspace) {
				const ws = manifest.workspace;
				if (ws.python?.length) {
					merged.python = [...(merged.python ?? []), ...ws.python];
				}
				if (ws.node?.length) {
					merged.node = [...(merged.node ?? []), ...ws.node];
				}
				if (ws.system?.length) {
					merged.system = [...(merged.system ?? []), ...ws.system];
				}
				if (ws.run?.length) {
					merged.run = [...(merged.run ?? []), ...ws.run];
				}
				if (ws.env) {
					merged.env = { ...(merged.env ?? {}), ...ws.env };
				}
				logger.info(
					{ extension: manifest.name, workspace: ws },
					"merged workspace requirements from extension",
				);
			}
		} catch {
			// No extension.json or invalid — skip
		}
	}

	return merged;
}

/** Generate a Dockerfile layer from merged requirements. */
function generateLayer(baseImage: string, reqs: WorkspaceRequirements): string {
	const lines: string[] = [
		"# ── Auto-generated workspace layer ───────────────────",
		"# Do not edit — regenerate with: beluga workspace build",
		`FROM ${baseImage}`,
		"",
	];

	// System packages
	if (reqs.system?.length) {
		lines.push("# ── System packages (from extensions) ───────────────");
		lines.push(
			`RUN apt-get update && apt-get install -y --no-install-recommends \\\n  ${reqs.system.map((p) => JSON.stringify(p)).join(" \\\n  ")} \\\n  && rm -rf /var/lib/apt/lists/*`,
		);
		lines.push("");
	}

	// Python packages
	if (reqs.python?.length) {
		lines.push("# ── Python packages (from extensions) ──────────────");
		lines.push(
			`RUN pip install --no-cache-dir --break-system-packages \\\n  ${reqs.python.map((p) => JSON.stringify(p)).join(" \\\n  ")}`,
		);
		lines.push("");
	}

	// Node packages
	if (reqs.node?.length) {
		lines.push("# ── Node.js packages (from extensions) ─────────────");
		lines.push(
			`RUN npm install -g \\\n  ${reqs.node.map((p) => JSON.stringify(p)).join(" \\\n  ")}`,
		);
		lines.push("");
	}

	// Custom RUN commands
	if (reqs.run?.length) {
		lines.push("# ── Custom RUN commands (from extensions) ──────────");
		for (const cmd of reqs.run) {
			lines.push(`RUN ${cmd}`);
		}
		lines.push("");
	}

	// Environment variables
	if (reqs.env && Object.keys(reqs.env).length > 0) {
		lines.push("# ── Environment variables (from extensions) ────────");
		for (const [key, value] of Object.entries(reqs.env)) {
			lines.push(`ENV ${key}=${JSON.stringify(value)}`);
		}
		lines.push("");
	}

	return lines.join("\n") + "\n";
}

/** Run a shell command and stream output. */
function runCommand(
	cmd: string,
	args: string[],
	logger: Logger,
): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: "inherit" });
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", (err) => {
			logger.error({ err }, "command failed");
			resolve(1);
		});
	});
}

/** Check if the base workspace image exists locally. */
async function baseImageExists(
	baseImage: string,
	logger: Logger,
): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("docker", ["image", "inspect", baseImage], {
			stdio: "ignore",
		});
		child.on("close", (code) => resolve(code === 0));
		child.on("error", () => resolve(false));
	});
}

export async function buildWorkspace(
	config: WorkspaceBuildConfig,
	logger: Logger,
	opts?: { force?: boolean },
): Promise<{ built: boolean; image: string; fingerprint: string }> {
	const extensionsDir = join(config.belugaDir, "extensions");

	// 1. Ensure base workspace image exists
	const hasBase = await baseImageExists(config.baseImage, logger);
	if (!hasBase) {
		logger.info("base workspace image not found, building from Dockerfile...");
		const baseDockerfile = config.baseDockerfile;
		const buildCode = await runCommand(
			"docker",
			[
				"build",
				"-f",
				baseDockerfile,
				"-t",
				config.baseImage,
				resolve(config.belugaDir, ".."),
			],
			logger,
		);
		if (buildCode !== 0) {
			throw new Error("failed to build base workspace image");
		}
		logger.info({ image: config.baseImage }, "base workspace image built");
	}

	// 2. Merge extension requirements
	const reqs = await mergeRequirements(extensionsDir, logger);
	const fp = fingerprint(reqs);

	// 3. Check fingerprint — skip if unchanged
	const cacheDir = join(config.belugaDir, "data");
	const cacheFile = join(cacheDir, "workspace-fingerprint");
	if (!opts?.force) {
		try {
			const cached = await readFile(cacheFile, "utf-8").then((s) => s.trim());
			if (cached === fp) {
				logger.info(
					{ fingerprint: fp },
					"workspace requirements unchanged, skipping build",
				);
				return { built: false, image: config.outputImage, fingerprint: fp };
			}
		} catch {
			// No cache file — proceed with build
		}
	}

	// 4. If no requirements, base image IS the output
	const hasRequirements =
		(reqs.python?.length ?? 0) > 0 ||
		(reqs.node?.length ?? 0) > 0 ||
		(reqs.system?.length ?? 0) > 0 ||
		(reqs.run?.length ?? 0) > 0 ||
		(reqs.env && Object.keys(reqs.env).length > 0);

	if (!hasRequirements) {
		// No extension requirements — just tag the base as output if different
		if (config.outputImage !== config.baseImage) {
			await runCommand(
				"docker",
				["tag", config.baseImage, config.outputImage],
				logger,
			);
		}
		await mkdir(cacheDir, { recursive: true });
		await writeFile(cacheFile, fp);
		logger.info("no extension workspace requirements, using base image");
		return { built: false, image: config.outputImage, fingerprint: fp };
	}

	// 5. Generate layer Dockerfile
	const layerDockerfile = join(cacheDir, "workspace-layer.Dockerfile");
	await mkdir(cacheDir, { recursive: true });
	const content = generateLayer(config.baseImage, reqs);
	await writeFile(layerDockerfile, content);

	logger.info(
		{ requirements: reqs, fingerprint: fp },
		"building composed workspace image",
	);

	// 6. Build
	const buildCode = await runCommand(
		"docker",
		["build", "-f", layerDockerfile, "-t", config.outputImage, cacheDir],
		logger,
	);

	if (buildCode !== 0) {
		throw new Error("failed to build composed workspace image");
	}

	// 7. Save fingerprint
	await writeFile(cacheFile, fp);

	logger.info(
		{ image: config.outputImage, fingerprint: fp },
		"workspace image built",
	);
	return { built: true, image: config.outputImage, fingerprint: fp };
}
