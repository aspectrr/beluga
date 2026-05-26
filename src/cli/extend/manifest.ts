// ── Extension manifest ────────────────────────────────────────
// Loads extension.json from an extension directory.

import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface ConfigField {
	name: string;
	type: string;
	description: string;
	required: boolean;
	default?: string;
	env_var?: string;
	secret?: boolean;
}

export interface ExtensionDependency {
	/** Extension name (must match the name in its extension.json). */
	name: string;
	/** Git URL to install from if not already present. */
	source: string;
}

export interface Manifest {
	name: string;
	version?: string;
	description?: string;
	type?: string;
	entrypoint?: string;
	config: ConfigField[];
	/** Other extensions this extension requires. Auto-installed if missing. */
	dependencies?: ExtensionDependency[];
}

export function loadManifest(dir: string): Manifest | null {
	const path = join(dir, "extension.json");
	if (existsSync(path)) {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as Manifest;
	}
	return null;
}
