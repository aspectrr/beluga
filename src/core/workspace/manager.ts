// ── Workspace manager + sandbox ────────────────────────────────
// Ported from internal/core/workspace/manager.go + sandbox.go

import Docker from "dockerode";
import type { Logger } from "pino";
import type { Extension } from "@aspectrr/beluga-sdk";

export interface ManagerConfig {
	dockerHost: string;
	agentImage: string;
	idleTimeout: number; // seconds
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

export class Sandbox {
	id: string;
	sessionId: string;
	containerIp: string;
	createdAt: Date;
	lastUsedAt: Date;

	private container: Docker.Container;
	private docker: Docker;

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

	async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
		this.lastUsedAt = new Date();
		const fullCmd = [cmd, ...args].join(" ");

		const exec = await this.container.exec({
			Cmd: ["/bin/sh", "-c", fullCmd],
			AttachStdout: true,
			AttachStderr: true,
		});

		const stream = await exec.start({ hijack: true, stdin: false });
		const chunks: Buffer[] = [];

		// Collect output from the multiplexed stream
		return new Promise((resolve, reject) => {
			let stdout = "";
			let stderr = "";

			// Docker multiplexed stream: 8-byte header (1 byte stream type + 3 bytes padding + 4 bytes size)
			stream.on("data", (chunk: Buffer) => {
				let offset = 0;
				while (offset < chunk.length) {
					if (offset + 8 > chunk.length) break;
					const streamType = chunk[offset];
					const size = chunk.readUInt32BE(offset + 4);
					offset += 8;
					if (offset + size > chunk.length) {
						// Partial frame — collect what we have
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
				const inspectResult = await exec.inspect();
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

	async stop(): Promise<void> {
		await this.container.stop().catch(() => {});
		await this.container.remove().catch(() => {});
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

		// Start idle cleanup timer
		this.cleanupTimer = setInterval(() => this.cleanupIdle(), 60000);
	}

	/** Set the extension manager for workspaceReady hooks. Called after extensions load. */
	setExtensionManager(mgr: { getAll(): Extension[] }): void {
		this.extensionManager = mgr;
	}

	async create(
		sessionId: string,
		config?: Partial<SandboxConfig>,
	): Promise<Sandbox> {
		const existing = this.sandboxes.get(sessionId);
		if (existing) return existing;

		const image = config?.image ?? this.config.agentImage;
		const cpuLimit = config?.cpuLimit ?? this.config.cpuLimit;
		const memoryLimit = config?.memoryLimit ?? this.config.memoryLimit;
		const networkMode = config?.networkMode ?? this.config.networkMode;

		this.logger.info({ sessionId, image }, "creating workspace sandbox");

		const container = await this.docker.createContainer({
			Image: image,
			Labels: { "beluga.session": sessionId },
			HostConfig: {
				NanoCpus: Math.floor(parseFloat(cpuLimit) * 1e9),
				Memory: this.parseMemory(memoryLimit),
				NetworkMode: networkMode === "none" ? "none" : networkMode,
			},
			WorkingDir: config?.workDir ?? "/workspace",
		});

		await container.start();

		// Get container IP
		const info = await container.inspect();
		const ip = info.NetworkSettings?.IPAddress ?? "";

		const sandbox = new Sandbox(this.docker, container, sessionId, ip);
		this.sandboxes.set(sessionId, sandbox);

		this.logger.info(
			{ sessionId, containerId: sandbox.id },
			"workspace sandbox created",
		);

		// Run onWorkspaceReady hooks from all extensions
		if (this.extensionManager) {
			const extensions = this.extensionManager.getAll();
			for (const ext of extensions) {
				if (ext.onWorkspaceReady) {
					try {
						await ext.onWorkspaceReady(sandbox);
						this.logger.info(
							{ extension: ext.name, sessionId },
							"onWorkspaceReady completed",
						);
					} catch (err) {
						this.logger.error(
							{ err, extension: ext.name, sessionId },
							"onWorkspaceReady failed",
						);
					}
				}
			}
		}

		return sandbox;
	}

	get(sessionId: string): Sandbox | undefined {
		return this.sandboxes.get(sessionId);
	}

	list(): Sandbox[] {
		return Array.from(this.sandboxes.values());
	}

	async destroy(sessionId: string): Promise<void> {
		const sandbox = this.sandboxes.get(sessionId);
		if (!sandbox) return;

		this.logger.info({ sessionId }, "destroying workspace sandbox");
		await sandbox.stop();
		this.sandboxes.delete(sessionId);
	}

	async cleanupIdle(): Promise<void> {
		const now = Date.now();
		for (const [id, sandbox] of this.sandboxes) {
			const idleMs = now - sandbox.lastUsedAt.getTime();
			if (idleMs > this.config.idleTimeout * 1000) {
				this.logger.info({ sessionId: id }, "cleaning up idle sandbox");
				await this.destroy(id).catch((err) => {
					this.logger.warn(
						{ err, sessionId: id },
						"failed to clean up idle sandbox",
					);
				});
			}
		}
	}

	async close(): Promise<void> {
		if (this.cleanupTimer) clearInterval(this.cleanupTimer);
		for (const id of this.sandboxes.keys()) {
			await this.destroy(id).catch(() => {});
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
