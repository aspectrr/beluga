// ── Extension scaffold ────────────────────────────────────────
// Ported from internal/cli/extend/scaffold.go

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";

export interface ScaffoldConfig {
	name: string;
	type: "local" | "remote";
	outDir: string;
}

export function scaffoldExtension(config: ScaffoldConfig): void {
	const dir = resolve(config.outDir, config.name);

	if (existsSync(dir)) {
		console.error(`directory already exists: ${dir}`);
		process.exit(1);
	}

	mkdirSync(dir, { recursive: true });

	if (config.type === "local") {
		scaffoldLocal(config.name, dir);
	} else {
		scaffoldRemote(config.name, dir);
	}

	console.log(`\n✓ extension '${config.name}' scaffolded at ${dir}`);
}

function scaffoldLocal(name: string, dir: string): void {
	// extension.json
	const manifest = {
		name,
		version: "0.1.0",
		description: `${name} extension for Beluga`,
		type: "local",
		entrypoint: "index.ts",
		config: [],
	};
	writeFileSync(
		join(dir, "extension.json"),
		JSON.stringify(manifest, null, 2) + "\n",
	);

	// index.ts
	writeFileSync(
		join(dir, "index.ts"),
		`import type { Extension, ExtensionContext } from "@aspectrr/beluga-sdk";

export class ${pascalCase(name)}Extension implements Extension {
  name = "${name}";

  async init(ctx: ExtensionContext): Promise<void> {
    ctx.logger.info("${name} extension initialized");

    // Register tools here:
    // ctx.registry.register(new MyTool());
  }

  async start(signal: AbortSignal): Promise<void> {
    // Long-running work (e.g. polling) goes here.
    // Return when signal.aborted becomes true.
  }

  async stop(): Promise<void> {
    // Clean up resources.
  }
}

export default ${pascalCase(name)}Extension;
`,
	);

	// README.md
	writeFileSync(
		join(dir, "README.md"),
		`# ${name}

Beluga extension.

## Development

Edit \`index.ts\` to add your tools and hooks.

## Install

\`\`\`bash
beluga extend install ./path/to/${name}
\`\`\`
`,
	);
}

function scaffoldRemote(name: string, dir: string): void {
	// extension.json
	const manifest = {
		name,
		version: "0.1.0",
		description: `${name} remote extension for Beluga`,
		type: "remote",
		config: [],
	};
	writeFileSync(
		join(dir, "extension.json"),
		JSON.stringify(manifest, null, 2) + "\n",
	);

	// main.ts
	writeFileSync(
		join(dir, "main.ts"),
		`// Remote extension entry point
// This runs as a standalone process and communicates via gRPC.

console.log("${name} remote extension starting...");
`,
	);

	writeFileSync(
		join(dir, "README.md"),
		`# ${name}

Beluga remote extension.

## Run

\`\`\`bash
bun run main.ts
\`\`\`
`,
	);
}

function pascalCase(s: string): string {
	return s
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}
