// ── Extension interface ────────────────────────────────────────
// Every Beluga extension must implement this interface.

import type { ExtensionContext } from "./context.js";
import type { SandboxRunner } from "./tools.js";

/** Declarative workspace requirements for an extension.
 *  Beluga merges these across all enabled extensions at workspace build time. */
export interface WorkspaceRequirements {
	/** Python packages to pip install */
	python?: string[];
	/** Node.js packages to npm install -g */
	node?: string[];
	/** System (apt) packages to install */
	system?: string[];
	/** Arbitrary RUN commands added to the generated Dockerfile layer */
	run?: string[];
	/** Environment variables to set in the workspace */
	env?: Record<string, string>;
}

export interface Extension {
	/** Unique identifier for this extension */
	name: string;

	/** Declarative workspace requirements. Merged at build time. */
	workspace?: WorkspaceRequirements;

	/** Called once at startup. Register tools, parse config, etc. */
	init(ctx: ExtensionContext): Promise<void>;

	/** Called after all extensions are initialized. Start background work here. */
	start(signal: AbortSignal): Promise<void>;

	/** Called on graceful shutdown. Clean up resources. */
	stop(): Promise<void>;

	/** Called after a workspace container is created for a session.
	 *  Use this to run imperative setup commands inside the container
	 *  (e.g. downloading binaries, generating config, starting services). */
	onWorkspaceReady?(sandbox: SandboxRunner): Promise<void>;
}
