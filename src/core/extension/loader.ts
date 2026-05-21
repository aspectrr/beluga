// ── Extension loader ──────────────────────────────────────────
// Scans .beluga/extensions/ at runtime, loads TS/JS extensions.
// Uses extension.json for manifest (name, entrypoint, config).

import { readdir, stat, readFile } from "fs/promises";
import { join, resolve } from "path";
import type { Logger } from "pino";
import type { Extension, ExtensionManager } from "./manager.js";
import type { ExtensionContext } from "./context.js";

export interface ExtensionManifest {
	name: string;
	entrypoint?: string;
	version?: string;
	description?: string;
	config?: Array<{
		name: string;
		type: string;
		description: string;
		required?: boolean;
		default?: string;
		env_var?: string;
		secret?: boolean;
	}>;
}

interface LoadedModule {
	default?: { new (): Extension } | Extension;
	init?: (ctx: ExtensionContext) => Promise<void>;
	start?: (signal: AbortSignal) => Promise<void>;
	stop?: () => Promise<void>;
	name?: string;
}

export async function loadRuntimeExtensions(
	extensionsDir: string,
	manager: ExtensionManager,
	getCtx: (name: string) => ExtensionContext,
	logger: Logger,
): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(extensionsDir);
	} catch {
		logger.debug({ dir: extensionsDir }, "no runtime extensions directory");
		return;
	}

	for (const entry of entries) {
		const extPath = join(extensionsDir, entry);
		const extStat = await stat(extPath);
		if (!extStat.isDirectory()) continue;

		try {
			const result = await loadExtension(extPath, logger);
			if (result) {
				const ctx = getCtx(result.name);
				manager.register(result.ext, ctx);
				logger.info({ extension: result.name }, "loaded runtime extension");
			}
		} catch (err) {
			logger.error({ err, path: extPath }, "failed to load runtime extension");
		}
	}
}

async function loadExtension(
	dir: string,
	logger: Logger,
): Promise<{ ext: Extension; name: string } | null> {
	const manifest = await loadManifest(dir, logger);
	if (!manifest) return null;

	const extName = manifest.name;
	if (!extName) {
		logger.warn({ dir }, "extension.json missing required 'name' field");
		return null;
	}

	const entrypoint = manifest.entrypoint ?? "index.ts";
	const entryPath = resolve(dir, entrypoint);

	// Dynamic import — Bun handles TS natively
	const mod = (await import(entryPath)) as LoadedModule;

	// If module exports a class as default, instantiate it
	if (mod.default) {
		const ExtClass = mod.default;
		let ext: Extension;
		if (typeof ExtClass === "function" && "prototype" in ExtClass) {
			ext = new (ExtClass as new () => Extension)();
		} else {
			ext = ExtClass as Extension;
		}
		return { ext, name: extName };
	}

	// If module exports init/start/stop directly, wrap it
	if (mod.init || mod.start || mod.stop) {
		return {
			ext: {
				name: extName,
				init: mod.init ?? (async () => {}),
				start: mod.start ?? (async () => {}),
				stop: mod.stop ?? (async () => {}),
			},
			name: extName,
		};
	}

	logger.warn(
		{ dir },
		"extension module has no default export or lifecycle functions",
	);
	return null;
}

async function loadManifest(
	dir: string,
	logger: Logger,
): Promise<ExtensionManifest | null> {
	const manifestPath = join(dir, "extension.json");
	try {
		const data = await readFile(manifestPath, "utf-8");
		return JSON.parse(data) as ExtensionManifest;
	} catch {
		logger.warn({ dir }, "no extension.json found");
		return null;
	}
}
