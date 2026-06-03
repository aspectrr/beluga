// ── Container log forwarding ──────────────────────────────────
// Attaches to Docker container stdout/stderr and forwards
// structured lines to a pino logger.

import type Docker from "dockerode";
import type { Logger } from "pino";

export interface LogForwardOptions {
	/** Docker container instance */
	container: Docker.Container;
	/** Pino logger to forward to */
	logger: Logger;
	/** Label included in every log line (e.g. "camofox", "workspace") */
	source: string;
	/** Container ID shorthand for log context */
	containerId: string;
	/** Whether to log JSON lines as structured data (default: true) */
	parseJson?: boolean;
}

/**
 * Attach to a running container's stdout/stderr and forward lines
 * to the pino logger. Returns a stop function.
 *
 * Handles both JSON-structured logs (camofox-browser) and plain text.
 */
export function forwardContainerLogs(opts: LogForwardOptions): () => void {
	const { container, logger, source, containerId } = opts;
	const parseJson = opts.parseJson ?? true;

	let stopped = false;

	(async () => {
		try {
			const stream = await container.logs({
				follow: true,
				stdout: true,
				stderr: true,
				tail: 0,
				timestamps: false,
			});

			// Docker multiplexed stream demux
			const { Writable } = await import("stream");
			let stdoutBuf = "";
			let stderrBuf = "";

			const stdout = new Writable({
				write(chunk, _encoding, callback) {
					stdoutBuf += chunk.toString("utf-8");
					const lines = stdoutBuf.split("\n");
					stdoutBuf = lines.pop() || "";
					for (const line of lines) {
						if (line.trim()) forwardLine(line, "stdout");
					}
					callback();
				},
			});

			const stderr = new Writable({
				write(chunk, _encoding, callback) {
					stderrBuf += chunk.toString("utf-8");
					const lines = stderrBuf.split("\n");
					stderrBuf = lines.pop() || "";
					for (const line of lines) {
						if (line.trim()) forwardLine(line, "stderr");
					}
					callback();
				},
			});

			container.modem.demuxStream(stream, stdout, stderr);

			stream.on("end", () => {
				if (!stopped) {
					logger.debug({ source, containerId }, "container log stream ended");
				}
			});

			stream.on("error", (err: Error) => {
				if (!stopped) {
					logger.warn(
						{ err, source, containerId },
						"container log stream error",
					);
				}
			});
		} catch (err) {
			if (!stopped) {
				logger.warn(
					{ err, source, containerId },
					"failed to attach container logs",
				);
			}
		}
	})();

	return () => {
		stopped = true;
	};

	function forwardLine(line: string, stream: "stdout" | "stderr") {
		// Strip Docker 8-byte header if present (sometimes leaks through)
		const cleaned = stripDockerHeader(line);
		if (!cleaned.trim()) return;

		if (parseJson) {
			try {
				const obj = JSON.parse(cleaned);
				// camofox-browser uses { ts, level, msg, ...fields }
				const level = obj.level || (stream === "stderr" ? "error" : "info");
				const msg = obj.msg || obj.message || cleaned;
				const fields = { ...obj, source, containerId, stream };
				delete fields.msg;
				delete fields.message;
				delete fields.ts;
				delete fields.level;

				if (level === "error") {
					logger.error(fields, msg);
				} else if (level === "warn" || level === "warning") {
					logger.warn(fields, msg);
				} else if (level === "debug") {
					logger.debug(fields, msg);
				} else {
					logger.info(fields, msg);
				}
				return;
			} catch {
				// Not JSON — fall through to plain text
			}
		}

		// Plain text log line
		if (stream === "stderr") {
			logger.warn({ source, containerId }, cleaned);
		} else {
			logger.info({ source, containerId }, cleaned);
		}
	}
}

/**
 * Docker log streams sometimes include 8-byte frame headers.
 * Strip them if present.
 */
function stripDockerHeader(line: string): string {
	// If first 8 bytes look like a Docker header (stream type 1-2, padding, size),
	// strip them. Check for common case where header leaked.
	if (line.length > 8) {
		const firstByte = line.charCodeAt(0);
		if (
			(firstByte === 1 || firstByte === 2) &&
			line.charCodeAt(1) === 0 &&
			line.charCodeAt(2) === 0 &&
			line.charCodeAt(3) === 0
		) {
			return line.slice(8);
		}
	}
	return line;
}
