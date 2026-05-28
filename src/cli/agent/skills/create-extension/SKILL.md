# Create Extension Skill

## Purpose

Guidance for creating and installing new Beluga extensions. Use this skill when a user asks you to create a new extension, add tools or capabilities to agents, or build a new integration.

## Creating a New Extension

### 1. Scaffold the extension

```bash
beluga extend create <extension-name> [-t local|remote] [-o <output-dir>]
```

- Default type: `local`
- Default output: current directory
- Creates `<dir>/<extension-name>/` containing:
  - `extension.json` — extension manifest
  - `index.ts` — entry point with boilerplate
  - `README.md`

### 2. Extension manifest (extension.json)

```json
{
  "name": "my-extension",
  "version": "0.1.0",
  "description": "What this extension does",
  "entrypoint": "index.ts",
  "config": [
    {
      "name": "api_key",
      "type": "string",
      "description": "API key for the service",
      "required": true,
      "secret": true,
      "env_var": "MY_EXTENSION_API_KEY"
    }
  ]
}
```

#### Manifest fields
- `name` — unique extension identifier (required)
- `entrypoint` — TS/JS entry file (default: `index.ts`)
- `description` — human-readable description
- `version` — semantic version
- `config` — array of config fields the extension declares

#### Config field schema
| Field        | Type    | Description                                        |
|-------------|---------|----------------------------------------------------|
| `name`      | string  | Config key name (required)                         |
| `type`      | string  | Value type: string, integer, boolean, duration     |
| `description` | string | Human-readable description                        |
| `required`  | boolean | Whether this field must be set                    |
| `default`   | string  | Default value                                      |
| `env_var`   | string  | Environment variable to read if not in config      |
| `secret`    | boolean | Mark as sensitive (masked in logs)                 |

### 3. Implement the extension

Edit `index.ts`. Every extension must implement the `Extension` interface:

```typescript
import type { Extension, ExtensionContext, Tool, ToolDef, ToolContext } from "@aspectrr/beluga-sdk";

class MyTool implements Tool {
  definition(): ToolDef {
    return {
      name: "my_tool",
      description: "What this tool does",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "The input" }
        },
        required: ["input"]
      }
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const input = args.input as string;
    // Tool logic here
    // ctx.agent contains the agent name for per-agent scoping
    // ctx.sessionId contains the session ID
    return { result: `processed: ${input}` };
  }
}

export default class MyExtension implements Extension {
  name = "my-extension";

  async init(ctx: ExtensionContext): Promise<void> {
    // Parse config
    const config = ctx.config;
    // Get scoped DB
    const db = ctx.db;
    // Register tools
    ctx.registry.register(new MyTool());
    // Use scoped logger
    ctx.logger.info("initialized");
  }

  async start(signal: AbortSignal): Promise<void> {
    // Background work (polling, etc). Return when signal.aborted.
  }

  async stop(): Promise<void> {
    // Clean up
  }
}
```

### 4. ExtensionContext API

| Property        | Type           | Description                                      |
|----------------|----------------|--------------------------------------------------|
| `config`       | `Record<string, unknown>` | Extension config from config.json       |
| `registry`     | `Registry`     | Register tools via `ctx.registry.register(tool)` |
| `sessions`     | `SessionStore` | Query/create sessions                            |
| `events`       | `EventStore`   | Read/append session events                       |
| `db`           | `ExtDB`        | Restricted SQL access (parameterized queries)    |
| `logger`       | `Logger`       | Scoped pino logger                               |
| `promptDir`    | `string`       | Path to prompts directory                        |
| `shared`       | `Record<string, unknown>` | Cross-extension shared state            |
| `createSession`| `function`     | Create a new session from an external trigger    |
| `continueSession`| `function`   | Continue an existing session                     |

### 5. ToolContext API (available in execute)

| Property      | Type     | Description                                  |
|--------------|----------|----------------------------------------------|
| `sessionId`  | `string` | Current session ID                           |
| `agent`      | `string` | Agent name — use this for per-agent scoping  |
| `sandbox`    | `SandboxRunner | null` | Workspace sandbox                     |
| `eventStore` | `EventStore | null`    | Event store for this session           |

### 6. Per-agent scoping

Extensions are loaded once globally but tools receive `ctx.agent` on every invocation. Use this to scope data:
- **File-based**: Store in `.beluga/agents/{ctx.agent}/your-data/`
- **Database**: Add an `agent` column and filter with `WHERE agent = ctx.agent`

### 7. Database access

```typescript
import { sql } from "drizzle-orm";

// Parameterized (safe, bypasses string validation)
await ctx.db.executeSql(sql`SELECT * FROM my_table WHERE agent = ${agent}`);

// Raw string (validated against permissions)
await ctx.db.query(`SELECT * FROM sessions WHERE id = '${id}'`);
```

Permissions:
- Can read core tables: `sessions`, `events`
- Can create/modify own tables
- Cannot: DROP, TRUNCATE, GRANT, REVOKE, write to core tables

### 8. Install the extension

```bash
beluga extend install ./path/to/extension
# or from git
beluga extend install https://github.com/org/beluga-ext-name
```

Install automatically:
- Copies extension to `.beluga/extensions/<name>/`
- Updates `.beluga/config.json` with config fields and defaults
- Prints required/optional config

### 9. Verify

```bash
beluga extend verify ./path/to/extension
```

### 10. Wire to agents

In each agent's `agent.json`, add the extension name to the `extensions` array:

```json
{
  "extensions": ["my-extension"],
  "extensionSources": {
    "my-extension": "https://github.com/org/beluga-ext-my-extension"
  }
}
```

### 11. Configure and restart

Edit `.beluga/config.json` to set required values, then:

```bash
beluga start
```

## Key Concepts

- **Extensions register tools**: Tools are the primary way extensions add capabilities
- **Tools are agent-scoped**: `ctx.agent` is always available in tool execution
- **Extensions load once**: A single instance serves all agents; use `ctx.agent` to differentiate
- **Config is global**: Extension config lives in `.beluga/config.json` under `extensions.<name>`
