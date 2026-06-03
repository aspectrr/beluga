// ── Workspace manager + sandbox ────────────────────────────────
// Persistent workspace containers with Docker volume backing.
//
// Lifecycle:
//   create()     → find existing (in-memory → Docker stopped → fresh)
//   idleTimeout  → container STOPPED (not removed), volume kept
//   resume       → stopped container restarted, all data intact
//   retentionTimeout → container + volume fully destroyed
//   recoverFromDocker() → restore refs after daemon restart

import Docker from "dockerode";
import type { Logger } from "pino";
import type { Extension } from "@aspectrr/beluga-sdk";
import { forwardContainerLogs } from "./container-logs.js";

export interface ManagerConfig {
	dockerHost: string;
	agentImage: string;
	idleTimeout: number; // seconds — stop container after this
	retentionTimeout: number; // seconds — fully destroy after this
	cpuLimit: string;
	memoryLimit: string;
	networkMode: string;
}

export interface SandboxConfig {
	image: string;
	cpuLimit: string;
	memoryLimit: string;
	networkMode: string;
	workDir: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export class ContainerNotRunningError extends Error {
	constructor(containerId: string) {
		super(`container ${containerId} is not running`);
		this.name = "ContainerNotRunningError";
	}
}

/** Derive a Docker volume name from a session ID. */
function volumeName(sessionId: string): string {
	return `beluga-ws-${sessionId}`;
}

export class Sandbox {
	id: string;
	sessionId: string;
	containerIp: string;
	createdAt: Date;
	lastUsedAt: Date;

	private docker: Docker;
	private container: Docker.Container;
	private stopCallbacks: Array<() => void> = [];

	constructor(
		docker: Docker,
		container: Docker.Container,
		sessionId: string,
		ip: string,
	) {
		this.docker = docker;
		this.container = container;
		this.id = container.id;
		this.sessionId = sessionId;
		this.containerIp = ip;
		this.createdAt = new Date();
		this.lastUsedAt = new Date();
	}

	/** Check if this sandbox's container is still running. */
	async isAlive(): Promise<boolean> {
		try {
			const info = await this.container.inspect();
			return info.State?.Running === true;
		} catch {
			return false;
		}
	}

	/** Get container state details for debugging. */
	async inspectState(): Promise<{
		running: boolean;
		exitCode?: number;
		error?: string;
		status?: string;
	}> {
		try {
			const info = await this.container.inspect();
			return {
				running: info.State?.Running ?? false,
				exitCode: info.State?.ExitCode,
				error: info.State?.Error,
				status: info.State?.Status,
			};
		} catch (err) {
			return { running: false, error: String(err) };
		}
	}

	async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
		this.lastUsedAt = new Date();
		const fullCmd = [cmd, ...args].join(" ");

		let execInstance: Docker.Exec;
		try {
			execInstance = await this.container.exec({
				Cmd: ["/bin/sh", "-c", fullCmd],
				AttachStdout: true,
				AttachStderr: true,
			});
		} catch (err: any) {
			if (
				err?.statusCode === 404 ||
				err?.statusCode === 409 ||
				(err?.message && err.message.includes("is not running")) ||
				(err?.message && err.message.includes("No such container"))
			) {
				throw new ContainerNotRunningError(this.id);
			}
			throw err;
		}

		let stream: NodeJS.ReadableStream;
		try {
			stream = await execInstance.start({});
		} catch (err: any) {
			if (
				err?.statusCode === 404 ||
				err?.statusCode === 409 ||
				(err?.message && err.message.includes("is not running")) ||
				(err?.message && err.message.includes("No such container"))
			) {
				throw new ContainerNotRunningError(this.id);
			}
			throw err;
		}

		return new Promise((resolve, reject) => {
			let stdout = "";
			let stderr = "";

			stream.on("data", (chunk: Buffer) => {
				let offset = 0;
				while (offset < chunk.length) {
					if (offset + 8 > chunk.length) break;
					const streamType = chunk[offset];
					const size = chunk.readUInt32BE(offset + 4);
					offset += 8;
					if (offset + size > chunk.length) {
						const partial = chunk.slice(offset).toString("utf-8");
						if (streamType === 1) stdout += partial;
						else stderr += partial;
						break;
					}
					const data = chunk.slice(offset, offset + size).toString("utf-8");
					if (streamType === 1) stdout += data;
					else stderr += data;
					offset += size;
				}
			});

			stream.on("end", async () => {
				const inspectResult = await execInstance.inspect();
				resolve({
					stdout,
					stderr,
					exitCode: inspectResult.ExitCode ?? 1,
				});
			});

			stream.on("error", reject);
		});
	}

	async readFile(path: string): Promise<string> {
		const result = await this.exec(`cat ${path}`);
		if (result.exitCode !== 0) {
			throw new Error(`readFile failed: ${result.stderr}`);
		}
		return result.stdout;
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		const encoded = Buffer.from(content).toString("base64");
		const result = await this.exec(`echo '${encoded}' | base64 -d > ${path}`);
		if (result.exitCode !== 0) {
			throw new Error(`writeFile failed: ${result.stderr}`);
		}
	}

	/** Stop the container (keep it around for resume). Does NOT remove it. */
	async stop(): Promise<void> {
		for (const cb of this.stopCallbacks) cb();
		this.stopCallbacks = [];
		try {
			const state = await this.inspectState();
			if (state.running) {
				await this.container.stop();
			}
		} catch (err: any) {
			if (!err?.message?.includes("is not running")) {
				throw err;
			}
		}
	}

	/** Restart a stopped container. */
	async restart(): Promise<void> {
		const state = await this.inspectState();
		if (!state.running) {
			await this.container.start();
		}
		const info = await this.container.inspect();
		this.containerIp = info.NetworkSettings?.IPAddress ?? "";
	}

	/** Fully destroy: stop + remove container + remove volume. */
	async destroy(): Promise<void> {
		for (const cb of this.stopCallbacks) cb();
		this.stopCallbacks = [];
		try {
			const state = await this.inspectState();
			if (state.running) {
				await this.container.stop();
			}
		} catch {
			// container may already be gone
		}
		await this.container.remove().catch(() => {});

		try {
			const vol = this.docker.getVolume(volumeName(this.sessionId));
			await vol.remove();
		} catch {
			// volume may already be gone
		}
	}

	/** Register a callback to run when this sandbox is stopped. */
	onStop(cb: () => void): void {
		this.stopCallbacks.push(cb);
	}
}

export class WorkspaceManager {
	private docker: Docker;
	private config: ManagerConfig;
	private logger: Logger;
	private sandboxes: Map<string, Sandbox> = new Map();
	private cleanupTimer?: Timer;
	private extensionManager?: { getAll(): Extension[] };

	constructor(config: ManagerConfig, logger: Logger) {
		this.config = config;
		this.logger = logger;

		const dockerOpts: Docker.DockerOptions = {};
		if (config.dockerHost) {
			dockerOpts.socketPath = config.dockerHost;
		}
		this.docker = new Docker(dockerOpts);

		this.cleanupTimer = setInterval(() => this.cleanupIdle(), 60000);
	}

	setExtensionManager(mgr: { getAll(): Extension[] }): void {
		this.extensionManager = mgr;
	}

	/**
	 * Get or create a workspace sandbox for a session.
	 *
	 * Recovery order:
	 *   1. In-memory cache (running sandbox)
	 *   2. Docker container with beluga.session label (stopped → restart)
	 *   3. Fresh container with existing volume (data survives)
	 *   4. Fresh container + fresh volume
	 */
	async create(
		sessionId: string,
		config?: Partial<SandboxConfig>,
	): Promise<Sandbox> {
		const image = config?.image ?? this.config.agentImage;
		const cpuLimit = config?.cpuLimit ?? this.config.cpuLimit;
		const memoryLimit = config?.memoryLimit ?? this.config.memoryLimit;
		const networkMode = config?.networkMode ?? this.config.networkMode;

		// 1. In-memory cache
		const existing = this.sandboxes.get(sessionId);
		if (existing) {
			const alive = await existing.isAlive();
			if (alive) {
				existing.lastUsedAt = new Date();
				return existing;
			}
			this.logger.info(
				{ sessionId, containerId: existing.id },
				"cached sandbox dead, recovering from Docker",
			);
			this.sandboxes.delete(sessionId);
		}

		// 2. Check Docker for existing stopped container
		const existingContainer = await this.findContainerBySession(sessionId);
		if (existingContainer) {
			this.logger.info(
				{ sessionId, containerId: existingContainer.id },
				"resuming existing stopped container",
			);
			return this.resumeContainer(sessionId, existingContainer);
		}

		// 3+4. Create fresh container (volume may already exist → data preserved)
		this.logger.info({ sessionId, image }, "creating workspace sandbox");
		const vol = volumeName(sessionId);

		try {
			await this.docker.createVolume({ Name: vol });
		} catch {
			// Volume already exists — data will be preserved
		}

		const container = await this.docker.createContainer({
			Image: image,
			Labels: { "beluga.session": sessionId },
			HostConfig: {
				NanoCpus: Math.floor(parseFloat(cpuLimit) * 1e9),
				Memory: this.parseMemory(memoryLimit),
				NetworkMode: networkMode === "none" ? "none" : networkMode,
				Binds: [`${vol}:/workspace`],
			},
			WorkingDir: config?.workDir ?? "/workspace",
		});

		await container.start();

		const postStartInfo = await container.inspect();
		const isRunning = postStartInfo.State?.Running ?? false;
		const exitCode = postStartInfo.State?.ExitCode;
		const error = postStartInfo.State?.Error;
		this.logger.info(
			{
				sessionId,
				containerId: container.id,
				isRunning,
				exitCode,
				error,
				status: postStartInfo.State?.Status,
			},
			"workspace container started",
		);
		if (!isRunning) {
			this.logger.error(
				{
					sessionId,
					containerId: container.id,
					exitCode,
					error,
					state: postStartInfo.State,
				},
				"workspace container exited immediately after start",
			);
			await container.remove().catch(() => {});
			throw new Error(
				`workspace container exited immediately (exitCode=${exitCode}, error=${error}). ` +
					`Ensure the workspace image CMD keeps the container alive (e.g. "sleep infinity").`,
			);
		}

		const ip = postStartInfo.NetworkSettings?.IPAddress ?? "";

		const sandbox = new Sandbox(this.docker, container, sessionId, ip);
		this.sandboxes.set(sessionId, sandbox);

		this.logger.info(
			{ sessionId, containerId: sandbox.id, ip, volume: vol },
			"workspace sandbox created with persistent volume",
		);

		this.attachLogForward(sandbox);
		await this.runWorkspaceReadyHooks(sandbox);

		return sandbox;
	}

	get(sessionId: string): Sandbox | undefined {
		const sandbox = this.sandboxes.get(sessionId);
		if (sandbox) {
			sandbox
				.inspectState()
				.then((state) => {
					if (!state.running) {
						this.logger.warn(
							{ sessionId, containerId: sandbox.id, state },
							"retrieved sandbox but container is not running",
						);
					}
				})
				.catch(() => {});
		}
		return sandbox;
	}

	list(): Sandbox[] {
		return Array.from(this.sandboxes.values());
	}

	/** Remove in-memory ref without touching Docker. Used when container died but volume should survive. */
	removeSandboxRef(sessionId: string): void {
		this.sandboxes.delete(sessionId);
	}

	async destroy(sessionId: string): Promise<void> {
		const sandbox = this.sandboxes.get(sessionId);
		if (sandbox) {
			this.logger.info({ sessionId }, "destroying workspace sandbox");
			await sandbox.destroy();
			this.sandboxes.delete(sessionId);
			return;
		}

		// Not in memory — check Docker for orphaned container
		const container = await this.findContainerBySession(sessionId);
		if (container) {
			this.logger.info(
				{ sessionId, containerId: container.id },
				"destroying orphaned container",
			);
			try {
				const info = await container.inspect();
				if (info.State?.Running) await container.stop();
			} catch {
				// container may already be gone
			}
			await container.remove().catch(() => {});
		}

		try {
			const vol = this.docker.getVolume(volumeName(sessionId));
			await vol.remove();
		} catch {
			// volume may already be gone
		}
	}

	/**
	 * Idle cleanup:
	 *   - idleTimeout exceeded → STOP container (keep for resume)
	 *   - retentionTimeout exceeded → full DESTROY (container + volume)
	 */
	async cleanupIdle(): Promise<void> {
		const now = Date.now();
		this.logger.debug(
			{
				activeSandboxes: this.sandboxes.size,
				idleTimeout: this.config.idleTimeout,
				retentionTimeout: this.config.retentionTimeout,
			},
			"running idle sandbox cleanup",
		);
		for (const [id, sandbox] of this.sandboxes) {
			const idleMs = now - sandbox.lastUsedAt.getTime();
			const idleSec = idleMs / 1000;

			if (idleSec > this.config.retentionTimeout) {
				this.logger.info(
					{
						sessionId: id,
						containerId: sandbox.id,
						idleMs,
						retentionTimeout: this.config.retentionTimeout,
					},
					"retention timeout exceeded, fully destroying workspace",
				);
				await sandbox.destroy().catch((err) => {
					this.logger.warn(
						{ err, sessionId: id },
						"failed to destroy expired sandbox",
					);
				});
				this.sandboxes.delete(id);
			} else if (idleSec > this.config.idleTimeout) {
				const state = await sandbox
					.inspectState()
					.catch(() => ({ running: false }));
				if (state.running) {
					this.logger.info(
						{
							sessionId: id,
							containerId: sandbox.id,
							idleMs,
							containerRunning: state.running,
						},
						"stopping idle sandbox (retained for resume)",
					);
					await sandbox.stop().catch((err) => {
						this.logger.warn(
							{ err, sessionId: id },
							"failed to stop idle sandbox",
						);
					});
				}
			}
		}

		await this.cleanupOrphanedContainers(now);
	}

	/**
	 * Recover workspace containers from Docker after daemon restart.
	 * Finds all containers with "beluga.session" label and adds them
	 * to the in-memory map.
	 */
	async recoverFromDocker(): Promise<void> {
		this.logger.info("recovering workspace containers from Docker");

		let containers: Docker.ContainerInfo[];
		try {
			containers = await this.docker.listContainers({
				all: true,
				filters: JSON.stringify({
					label: ["beluga.session"],
				}),
			});
		} catch (err) {
			this.logger.warn({ err }, "failed to list containers for recovery");
			return;
		}

		const now = Date.now();

		for (const info of containers) {
			const sessionId = info.Labels?.["beluga.session"];
			if (!sessionId) continue;
			if (this.sandboxes.has(sessionId)) continue;

			const createdMs = new Date(info.Created * 1000).getTime();
			const ageSec = (now - createdMs) / 1000;
			if (ageSec > this.config.retentionTimeout) {
				this.logger.info(
					{ sessionId, containerId: info.Id, ageSec },
					"recovered container exceeded retention, destroying",
				);
				const container = this.docker.getContainer(info.Id);
				try {
					if (info.State === "running") await container.stop();
				} catch {
					// already gone
				}
				await container.remove().catch(() => {});
				try {
					const vol = this.docker.getVolume(volumeName(sessionId));
					await vol.remove();
				} catch {
					// already gone
				}
				continue;
			}

			const container = this.docker.getContainer(info.Id);
			const sandbox = new Sandbox(
				this.docker,
				container,
				sessionId,
				info.NetworkSettings?.Networks
					? (Object.values(info.NetworkSettings.Networks)[0]?.IPAddress ?? "")
					: "",
			);

			sandbox.createdAt = new Date(info.Created * 1000);
			sandbox.lastUsedAt = new Date();

			this.sandboxes.set(sessionId, sandbox);

			const state = info.State ?? "unknown";
			this.logger.info(
				{ sessionId, containerId: info.Id.slice(0, 12), state },
				"recovered workspace container",
			);

			if (state === "running") {
				this.attachLogForward(sandbox);
			}
		}

		this.logger.info(
			{ count: this.sandboxes.size },
			"workspace recovery complete",
		);
	}

	async close(): Promise<void> {
		if (this.cleanupTimer) clearInterval(this.cleanupTimer);
		for (const [, sandbox] of this.sandboxes) {
			await sandbox.stop().catch(() => {});
		}
		this.sandboxes.clear();
	}

	// ── Private helpers ──────────────────────────────────────────

	private async findContainerBySession(
		sessionId: string,
	): Promise<Docker.Container | null> {
		try {
			const containers = await this.docker.listContainers({
				all: true,
				filters: JSON.stringify({
					label: [`beluga.session=${sessionId}`],
				}),
			});
			if (containers.length > 0) {
				return this.docker.getContainer(containers[0].Id);
			}
		} catch (err) {
			this.logger.debug(
				{ err, sessionId },
				"failed to query Docker for existing container",
			);
		}
		return null;
	}

	private async resumeContainer(
		sessionId: string,
		container: Docker.Container,
	): Promise<Sandbox> {
		await container.start();
		const info = await container.inspect();
		const ip = info.NetworkSettings?.IPAddress ?? "";

		const sandbox = new Sandbox(this.docker, container, sessionId, ip);
		sandbox.lastUsedAt = new Date();
		this.sandboxes.set(sessionId, sandbox);

		this.logger.info(
			{ sessionId, containerId: sandbox.id, ip },
			"resumed workspace container",
		);

		this.attachLogForward(sandbox);
		return sandbox;
	}

	private attachLogForward(sandbox: Sandbox): void {
		const container = (sandbox as any).container as Docker.Container;
		const stopLogForward = forwardContainerLogs({
			container,
			logger: this.logger.child({
				source: "workspace",
				containerId: sandbox.id.slice(0, 12),
			}),
			source: "workspace",
			containerId: sandbox.id.slice(0, 12),
			parseJson: false,
		});
		sandbox.onStop(stopLogForward);
	}

	private async runWorkspaceReadyHooks(sandbox: Sandbox): Promise<void> {
		if (!this.extensionManager) {
			this.logger.debug(
				{ sessionId: sandbox.sessionId },
				"workspace ready: no extension manager available",
			);
			return;
		}

		const extensions = this.extensionManager.getAll();
		this.logger.debug(
			{ sessionId: sandbox.sessionId, extensionCount: extensions.length },
			"workspace ready: calling onWorkspaceReady hooks",
		);
		for (const ext of extensions) {
			if (ext.onWorkspaceReady) {
				this.logger.debug(
					{ extension: ext.name, sessionId: sandbox.sessionId },
					"calling onWorkspaceReady",
				);
				try {
					await ext.onWorkspaceReady(sandbox);
					this.logger.info(
						{ extension: ext.name, sessionId: sandbox.sessionId },
						"onWorkspaceReady completed",
					);
				} catch (err) {
					this.logger.error(
						{ err, extension: ext.name, sessionId: sandbox.sessionId },
						"onWorkspaceReady failed",
					);
				}
			}
		}
	}

	private async cleanupOrphanedContainers(now: number): Promise<void> {
		let containers: Docker.ContainerInfo[];
		try {
			containers = await this.docker.listContainers({
				all: true,
				filters: JSON.stringify({
					label: ["beluga.session"],
				}),
			});
		} catch {
			return;
		}

		for (const info of containers) {
			const sessionId = info.Labels?.["beluga.session"];
			if (!sessionId) continue;
			if (this.sandboxes.has(sessionId)) continue;

			const createdMs = new Date(info.Created * 1000).getTime();
			const ageSec = (now - createdMs) / 1000;

			if (ageSec > this.config.retentionTimeout) {
				this.logger.info(
					{ sessionId, containerId: info.Id, ageSec },
					"destroying orphaned container past retention",
				);
				const container = this.docker.getContainer(info.Id);
				try {
					if (info.State === "running") await container.stop();
				} catch {
					// already gone
				}
				await container.remove().catch(() => {});
				try {
					const vol = this.docker.getVolume(volumeName(sessionId));
					await vol.remove();
				} catch {
					// already gone
				}
			}
		}
	}

	private parseMemory(mem: string): number {
		const match = mem.match(/^(\d+)([kmg]?)$/i);
		if (!match) return 512 * 1024 * 1024;
		const n = parseInt(match[1]);
		const unit = match[2].toLowerCase();
		if (unit === "g") return n * 1024 * 1024 * 1024;
		if (unit === "m") return n * 1024 * 1024;
		if (unit === "k") return n * 1024;
		return n;
	}
}
