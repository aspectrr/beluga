# Beluga - PRD & Architecture

> 🐋 Managed Agents that are yours. There are many managed agent providers but this one is yours.

## What Beluga Is

Beluga is a minimal managed agent runtime - autonomous agents that have their own workspaces, that are meant to be extended with new capabilities. Make them yours and have them adapt to your workflow. It's meant to adapt to it's users, not the other way around. Build workflows and functionalities that each user needs.

Beluga is minimal by default, and meant to adapt the user.

A managed agent is an autonomous agent with:

- A durable **workspace** (Docker sandbox) where it can read/write files and run commands
- A set of **tools** it can use (3 defaults, replace the built in ones or add whatever ones you want)
- A **session** model that persists across restarts
- **Prompt templates** that shape how the agent thinks and behaves

Skills, history search, and domain-specific capabilities are all added through extensions.

Beluga provides the core runtime. Extensions add the domain-specific parts.

## Setup

When you first run `beluga onboard`, it launches an interactive onboarding flow:

1. **LLM Setup** — Asks for an endpoint URL and API key. Beluga tests the connection by listing available models. 
2. **Chat Connector** — Asks where you want to talk to the agent (ClickUp, Slack, etc.). Installs and configures the connector.
3. **Done.** Start talking to your agent.

From there, you can ask the agent to install/build extensions for what you need (maybe you want an on call agent to manage your systems, maybe you want a finance analyst agent to build models for you, maybe you want a real estate analyst agent that provides deal flow modeling. The options will grow as you look deeper). The philosophy of Beluga is `as simple as possible and no simpler` — Einstein and the philosophy of the Pi Coding Agent, which is an extensible coding agent surface that you can extend however you want. I want to model that ethos by giving people the bare minimum of what they need to get started and when they need something, whether in the middle of chat or in the middle of the night, they can ask for a feature/tool/connection and their agents will grow. I would like Beluga to be the last agents you ever need. People want something that is easy to setup and they never have to rip out and replace later and doesn't need a ton of maintenance or constant updates. They want it to just work but also be extensible. This is that (hopefully) for managed agents.

I would prefer you self host, I'd rather not deal with that shit. Use Fly.io to install docker and use that brother.

## Design Principles

1. **As simple as possible, and no simpler.** Every concept must earn its place.
2. **Composition over configuration.** Extensions compose; they don't conflict.
3. **Safe defaults.** Sandboxes have no network. Tools are explicitly registered.
4. **Compounding knowledge.** Extensions like skills and history make agents better over time.
5. **Conversational adaptability.** Talk to the agent; it grows. Add extensions; it gains capabilities.

---

## Core Primitives (4 things)

Beluga has 4 core primitives. Skills and history are first-party extensions built on top of sessions, tools, and the filesystem. Everything else is an extension too.

### 1. Session

A durable record of an agent interaction. Survives crashes and restarts.

```
Session {
    ID          string
    Status      pending | running | suspended | completed | failed
    Source      string          // which connector created it (e.g. "clickup", "slack")
    SourceID    string          // external ID (e.g. ClickUp task ID, Slack thread TS)
    SandboxID   *string         // linked workspace sandbox (nil until created)
    Metadata    JSON            // arbitrary extension data
    CreatedAt   time
    UpdatedAt   time
}
```

Sessions have an **append-only event log** - every message, tool call, tool result, interrupt, error, and status transition. This is the source of truth for replay, auditing, and resumption.

### 2. Workspace

A Docker container where the agent works. Every running session can have one.

```
Workspace {
    ID           string
    SessionID    string
    ContainerIP  string
    CreatedAt    time
    LastUsedAt   time
}
```

The workspace supports three operations:

- **Bash** - run a command (returns stdout, stderr, exit code)
- **ReadFile** - read a file from the container
- **EditFile** - edit a file into the container

Default: no network, resource-limited, idle-timeout cleanup. Extensions can create different workspace types (see "Sandbox Providers" below).

The workspace image includes a Go toolchain, Python toolchain and the Beluga module dependencies so agents can develop and verify extensions locally. This is only used when the agent is building extensions - normal agent work doesn't require it.

### 3. Tool

A function the agent can call. Tools are defined by a JSON Schema and executed by the runtime.

```go
type Tool interface {
    Definition() ToolDef          // name, description, JSON schema for LLM
    Execute(ctx, args, ToolContext) (json.RawMessage, error)
}
```

Tools are registered in a **Tool Registry** - a thread-safe map of tool names to implementations. The registry is what gets passed to the LLM for function calling.

The core runtime provides 3 built-in tools:

- `workspace_bash` - run a command in the workspace sandbox
- `workspace_read_file` - read a file from the workspace
- `workspace_edit_file` - edit a file to the workspace

Everything else is added by extensions.

### 4. Prompt Template

A markdown fragment that gets injected into the agent's system prompt. Prompt templates live on the filesystem and are composed together at session start.

```
.beluga/
├── SYSTEM.md              # Base system prompt (always injected)
├── prompts/               # Prompt templates from extensions
│   ├── clickup.md         # e.g. "You have access to ClickUp tools..."
│   └── github.md          # e.g. "When working with PRs..."
└── skills/                # Skills (if the evolving-skills extension is enabled)
    ├── extension-builder/  # Built-in skill
    │   ├── SKILL.md        # The knowledge content
    │   └── prompt.md       # Prompt template injected when skill is relevant
    └── kafka-debugging/    # Agent-created skill
        ├── SKILL.md
        └── prompt.md
```

**How it works:**

1. `SYSTEM.md` is the base system prompt. It defines who the agent is, how it behaves, and any core instructions. Beluga ships with a default `SYSTEM.md`; users can edit it freely.
2. Extensions can contribute prompt templates to `.beluga/prompts/`. These are appended to the system prompt when the extension is enabled.
3. Skills (when the evolving-skills extension is enabled) can bundle their own `prompt.md` files. When a skill is relevant to the current session, its `prompt.md` is injected alongside the skill content.

This composition model means:

- The agent's personality lives in `SYSTEM.md` (user-editable)
- Extensions add behavioral context through prompt templates
- Skills add task-specific knowledge with their own prompts
- Everything is files — readable, editable, version-controllable

### 5. Skill (First-Party Extension)

Skills are a first-party extension (`evolving-skills`), not a core primitive. The filesystem is the source of truth — each skill is a folder under `.beluga/skills/` with a `SKILL.md` containing the knowledge and an optional `prompt.md` that gets injected into the system prompt when the skill is relevant.

Skills are searched using grep/ripgrep over the file contents. No database, no embeddings — just files on disk. Humans can browse, edit, and add skills directly. Agents create new skills as they learn.

The evolving-skills extension:

- Registers `skill_search` and `skill_create` tools
- Prompts the agent to search skills when facing unfamiliar problems
- Prompts the agent to create a skill at the end of each session
- Injects relevant skill content + prompt templates into the system prompt

Beluga ships with one built-in skill:

- **extension-builder** - teaches the agent how to build, verify, and install extensions. Includes code patterns, JSON Schema conventions, dry-run mock patterns, and the full `beluga extend` workflow. This skill is always available and is what enables agents to extend their own capabilities.

### 6. Extension

A bundle that adds capabilities to a managed agent. Extensions are Go packages compiled into the binary, enabled/disabled via config.

An extension can provide any combination of:

- **Connector** — triggers sessions from external events (ClickUp poller, Slack listener, webhook)
- **Tool Provider** — registers tools the agent can use (GitHub, ClickUp, custom APIs)
- **Sandbox Provider** — creates specialized workspace types (pipeline sandboxes, database sandboxes)
- **Host Provider** — manages connections to remote daemons on other machines, exposing their capabilities as tools
- **Extension Host** — provides a gRPC server and accepts tool registrations from external processes. This is the `ext_host` extension — core Beluga has no gRPC code.

```go
type Extension interface {
    Name() string
    Init(ctx ExtensionContext) error
    Start(ctx context.Context) error
    Stop(ctx context.Context) error
}

type ExtensionContext struct {
    Config       json.RawMessage       // extension-specific config from yaml
    Registry     *tools.Registry       // register tools here
    Sessions     *session.Store        // create/query sessions
    Events       *eventstore.Store     // append/query events
    DB           *sql.DB               // direct database access for custom queries/migrations
    Docker       *client.Client        // create custom sandboxes
    Logger       *slog.Logger

    // PromptDir is the path to .beluga/prompts/. Extensions can write
    // prompt template files here to inject behavioral context into the system prompt.
    PromptDir    string

    // GRPC - nil unless ext_host is enabled. Extensions that need
    // to register gRPC services should check this and fail clearly.
    GRPC         *GRPCProvider         // gRPC server + connection manager (provided by ext_host)

    // Connector callback: create a new session from an external event
    CreateSession func(ctx context.Context, source, sourceID string, metadata json.RawMessage) (*model.Session, error)
}
```

Extensions are Go packages that implement this interface. They are compiled into the binary and enabled/disabled via config.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       beluga (core)                          │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────────┐  │
│  │ Agent    │  │ Session  │  │ Tool Registry              │  │
│  │ Loop     │  │ Store    │  │                            │  │
│  │          │  │          │  │ workspace_exec             │  │
│  │ orchestr │  │ + Events │  │ workspace_read             │  │
│  │ ator     │  │   Store  │  │ workspace_write            │  │
│  │          │  │          │  │ + extension tools          │  │
│  └────┬─────┘  └──────────┘  └────────────────────────────┘  │
│       │                                                      │
│  ┌────┴──────────────┐  ┌─────────────────────────┐          │
│  │ Workspace Manager  │  │ Prompt Assembler        │          │
│  │ (Docker)           │  │ SYSTEM.md + prompts/    │          │
│  └────────────────────┘  │ + skills/*/prompt.md   │          │
│                          └─────────────────────────┘          │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Extension Manager                                       │  │
│  │  Init() → Start() → Stop()                              │  │
│  │  Passes: Registry, Sessions, Events, DB, PromptDir,   │  │
│  │          Docker, Logger, CreateSession callback          │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
          │
          │ GRPCProvider is nil unless ext_host is enabled
          │
          ┌────────────────────────────────────────────┐
          │ ext_host (extension, not core)              │
          │                                              │
          │  ┌──────────────┐  ┌──────────────────┐    │
          │  │ gRPC Server   │  │ Connection Mgr   │    │
          │  └──────┬───────┘  └──────────────────┘    │
          │         │                                   │
          │    exposes GRPCProvider to other extensions │
          │         │                                   │
          │    ┌────┴────┐   ┌──────────┐              │
          │    │ Remora  │   │ Remote   │              │
          │    │ Service │   │ Ext      │              │
          │    │ (tools) │   │ Service  │              │
          │    └────┬────┘   └────┬─────┘              │
          └─────────┼─────────────┼────────────────────┘
                    │             │
              ┌─────┴────┐  ┌────┴─────┐
              │ Remora   │  │ Remote   │
              │ daemons  │  │ ext      │
              │ on hosts │  │ processes│
              └──────────┘  └──────────┘

   All extensions (compiled in):
   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐
   │ ClickUp  │ │ GitHub   │ │ Pipeline │ │ Remora   │ │ ext_host │ │ evolving-    │ │ searchable-  │
   │ conn+tls │ │ tools    │ │ sbx+tls  │ │ host mgr │ │ grpc     │ │ skills       │ │ history      │
   │          │ │          │ │          │ │ needs EH │ │ + remote │ │ file-based   │ │ embedding opt│
   │          │ │          │ │          │ │          │ │ ext host │ │ + prompts    │ │ full-text fb │
   └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────┘ └──────────────┘
```

Core Beluga has no gRPC code. The `Remote Extension Host` extension provides the gRPC server and connection manager. Other extensions that need gRPC (like Remora) register services on it. If `remote_extension_host` is not enabled, `ctx.GRPC` is nil and nothing listens on the network.

---

## Extension Patterns

### Pattern 1: Connector + Tools (e.g. ClickUp, Slack)

The extension starts a background goroutine that polls or listens for external events. When it finds one, it calls `CreateSession()` to create a new agent session. It also registers tools so the agent can interact back with the source.

```yaml
extensions:
  clickup:
    enabled: true
    api_token: ${CLICKUP_API_TOKEN}
    team_id: "9012345678"
    space_id: "90123456789"
    agent_username: "Beluga Agent"
    poll_interval: "30s"
```

The ClickUp extension:

- **Init**: creates API client from config
- **Start**: starts poller goroutine → calls `CreateSession` on new tasks/mentions
- **Registers tools**: `clickup_post_comment`, `clickup_get_task`, `clickup_search_tasks`, etc.
- **Stop**: stops poller

### Pattern 2: Tools Only (e.g. GitHub, Jira)

No background process. Just registers tools the agent can use.

```yaml
extensions:
  github:
    enabled: true
    app_id: 123456
    private_key: ${GITHUB_PRIVATE_KEY}
    branch_prefix: "agent/"
    protected_refs: ["main", "master", "release/*"]
```

The GitHub extension:

- **Init**: creates GitHub App client from config
- **Start**: no-op (no background process needed)
- **Registers tools**: `github_push_to_branch`, `github_create_pull_request`, `github_comment_on_pull_request`, etc.
- **Stop**: no-op

### Pattern 3: Sandbox Provider + Tools (e.g. Pipeline Sandbox)

Creates specialized sandbox environments beyond the basic workspace. The agent can spin these up on demand through tools.

The sandbox provider provides Hooks where the sandbox provider can run functions like:
`PreSandboxStart`, `PostSandboxStart`, `PreSandboxStop`, `PostSandboxStop`. This is where (for example) the pipeline sandbox provider would run a sed function to replace everything in the `/etc/logstash` volume that has an array of kafka providers with the redpanda internal url and replace all output providers with the array of elasticsearch interal url.

```yaml
extensions:
  pipeline:
    enabled: true
    redpanda_image: "docker.redpanda.com/redpandadata/redpanda:latest"
    elasticsearch_image: "docker.elastic.co/elasticsearch/elasticsearch:8.17.0"
    logstash_image: "docker.elastic.co/logstash/logstash:8.17.0"
```

The Pipeline extension:

- **Init**: stores config
- **Registers tools**: `pipeline_send_data`, `pipeline_query_es`, `pipeline_get_logstash_status`, `pipeline_update_config`, `pipeline_health`
- **Internal**: manages Docker containers for Redpanda/Logstash/ES per session
- **Volumes**: Attach volumes to the new containers
- **Stop**: tears down all pipeline sandboxes

### Pattern 4: Host Provider + Tools (e.g. Remora Daemon)

The problem: you have machines on your network (log parsers, database servers, monitoring hosts) that the agent needs to investigate, but the agent's workspace sandbox can't reach them. You need a small, locked-down process on those machines that the agent can talk to.

Remora solves this. It has three parts:

1. **ext_host** - registers a gRPC shared server that is started up on default and allows remote extensions to connect.
2. **The Remora extension** (runs inside Beluga) — registers a gRPC service on ext_host's shared server, tracks connected daemons, registers tools like `host_exec` and `host_grep` that route through daemon connections
3. **The Remora daemon binary** (runs on remote hosts) — connects to Beluga's gRPC server, executes whitelisted read-only commands, syncs directories

**Dependency:** Remora requires `ext_host` to be enabled. If `ext_host` is not in the config, the Remora extension fails with a clear error: "ext_host extension is required for remora — enable ext_host first."

```yaml
extensions:
  ext_host:
    enabled: true # required for remora
    address: ":50051"
    tls_cert: "${BELUGA_TLS_CERT}"
    tls_key: "${BELUGA_TLS_KEY}"
  remora:
    enabled: true
```

The Remora extension:

- **Init**: checks `ctx.GRPC` is not nil (fails if ext_host not enabled). Registers a `RemoraService` gRPC service on `ctx.GRPC.RegisterService()`.
- **Registers tools**: `host_exec`, `host_read_file`, `host_grep`, `host_cat`, `host_tail`, `host_find`, `host_journalctl`. Each tool takes a `host` parameter (which daemon to route to).
- **Internal**: uses `ctx.GRPC.Connections` to track connected daemons, route commands, handle reconnection
- **Stop**: graceful drain of active commands

The daemon binary (`cmd/remora/`) connects to Beluga, registers itself, and handles command execution requests.

```go
// internal/extensions/remora/remora.go (simplified)
func (e *Extension) Init(ctx extension.ExtensionContext) error {
    if ctx.GRPC == nil {
        return fmt.Errorf("ext_host extension is required for remora — enable ext_host first")
    }

    // Register gRPC service on ext_host's shared server
    server := NewRemoraServer(e.manager, ctx.Logger)
    ctx.GRPC.RegisterService(&pb.RemoraService_ServiceDesc, server)

    // Register tools that route through daemon connections
    RegisterHostTools(ctx.Registry, e.manager)

    return nil
}
```

**Deployment order:** Beluga must be running before Remora daemons can connect. But the daemons auto-reconnect with backoff, so the order doesn't need to be exact. Install Beluga first, then deploy the daemon binary to remote hosts via Ansible.

### Pattern 5: Remote Extension Host (`ext_host`)

Provides the gRPC server that everything else uses. Core Beluga has no gRPC code — `ext_host` is the extension that starts the server and exposes a `GRPCProvider` to other extensions.

It does two things:

1. **Provides shared gRPC infrastructure** — starts a gRPC server, manages TLS, tracks connections. Other extensions (like Remora) register their gRPC services on this server during `Init()`.
2. **Accepts remote extension connections** — external processes can connect over a bidirectional gRPC stream, register their tools, and receive tool calls. These tools appear in the registry just like compiled-in extensions.

```yaml
extensions:
  ext_host:
    enabled: true
    address: ":50051"
    tls_cert: "${BELUGA_TLS_CERT}"
    tls_key: "${BELUGA_TLS_KEY}"
```

The ext_host extension:

- **Init**: creates the gRPC server and connection manager. Stores the `GRPCProvider` where other extensions can access it via `ctx.GRPC`.
- **Registers its own gRPC service**: `ExtensionHostService` — the bidirectional stream for remote extensions.
- **Start**: starts the gRPC server listening on the configured address.
- **Dynamic tool registration**: when a remote process connects and sends tool definitions, they're added to the tool registry. When it disconnects, they're removed.
- **Proxy**: when the agent calls a remote tool, execution is routed over gRPC to the remote process.
- **Stop**: graceful drain, disconnects remotes, stops server.

```go
// internal/extensions/ext_host/ext_host.go (simplified)
func (e *Extension) Init(ctx extension.ExtensionContext) error {
    // Parse config
    var cfg Config
    json.Unmarshal(ctx.Config, &cfg)

    // Create the gRPC server — this is what ctx.GRPC points to
    provider := NewGRPCProvider(cfg.Address, cfg.TLSCert, cfg.TLSKey, ctx.Logger)
    ctx.GRPC = provider  // available to extensions initialized after ext_host

    // Register the remote extension host service on our own server
    provider.RegisterService(&ExtensionHostServiceDesc, NewRemoteExtServer(provider, ctx.Registry, ctx.Logger))

    return nil
}
```

Remote extensions can be written in any language. The protocol is a protobuf bidirectional stream:

```protobuf
service ExtensionHost {
    rpc Connect(stream ExtensionMessage) returns (stream HostRequest);
}

message ExtensionMessage {
    oneof payload {
        Registration   registration   = 1;
        ToolResult     tool_result    = 2;
    }
}

message HostRequest {
    oneof payload {
        ExecuteTool    execute_tool   = 1;
    }
}
```

A remote extension process:

1. Connects to ext_host's gRPC server
2. Sends a `Register` message with tool definitions (name, description, JSON schema)
3. Receives `ExecuteTool` requests over the stream
4. Returns `ToolResult` responses

If a remote extension disconnects (crash, update, removal), its tools disappear from the registry. The agent gets a clear "extension offline" error. Active sessions aren't disrupted — they just lose access to that extension's tools until it reconnects.

**Dependency note:** ext_host must be initialized before Remora (and any other extension that needs gRPC). The extension manager handles this by initializing extensions in config order — put `ext_host` first.

### Pattern 6: Searchable History (`searchable_history`)

The problem: an agent that can't remember past sessions is stuck repeating the same investigations. But raw session events are noisy — a typical session has user messages, agent messages, tool calls with verbose output, and status transitions. You don't want to search through 200 lines of `kubectl` output to find "that time we dealt with the OOMKill."

If the endpoint supports embedding models (detected via `/v1/models` filtering for embedding-capable models), it lists them and asks which to use. The user's selection sets `embedding_model` and `embedding_dimensions` in the config automatically. If no embedding models are found, history search falls back to PostgreSQL full-text search — no extra setup required.

The searchable history extension solves this by building **session digests** — the conversation stripped down to just the messages. No LLM summarization. The agent reasons through the results itself.

#### How Digests Work

When a session completes, the extension processes its event log:

1. **User messages** — kept verbatim.
2. **Agent messages** — kept verbatim.
3. **Tool calls, tool results, status events** — stripped entirely.

The digest is just the conversation. No summarization, no LLM call, no inference. Just strip the noise.

```
Raw session (200 events):
  user_message:   "The kafka consumer is lagging, can you check?"
  agent_message:  "I'll investigate the consumer group."
  tool_call:      workspace_bash("kubectl get pods -n kafka")
  tool_result:    [47 lines of pod status YAML]
  tool_call:      workspace_bash("kubectl logs kafka-consumer-7b8d --tail=100")
  tool_result:    [100 lines of log output]
  agent_message:  "Found it — the consumer is hitting OOMKill. The pod has 512MB limit..."
  agent_message:  "I've increased the memory limit to 2GB and restarted the consumer."
  ...

Digest (stored, searchable):
  user: "The kafka consumer is lagging, can you check?"
  agent: "I'll investigate the consumer group."
  agent: "Found it — the consumer is hitting OOMKill. The pod has 512MB limit..."
  agent: "I've increased the memory limit to 2GB and restarted the consumer."
```

Digests are stored in a `session_digests` table owned by the extension:

```sql
CREATE TABLE session_digests (
    session_id  UUID PRIMARY KEY REFERENCES sessions(id),
    source      TEXT,                    -- which connector ("clickup", "slack")
    digest      TEXT NOT NULL,           -- messages only, tool events stripped
    digest_tsv  TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', digest)) STORED,
    embedding   vector(1536),            -- optional, only if pgvector + embedding model
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_digests_tsv ON session_digests USING GIN (digest_tsv);
```

The extension creates this table during `Init()` using `ctx.DB`. If pgvector is available, the `embedding` column is included. If not, the column is omitted — full-text search only.

#### Two Search Modes

**Full-text mode (default):**

- Searches `digest_tsv` using `to_tsquery`
- No extra infrastructure, no embedding model needed
- Works on any PostgreSQL
- Good for keyword-based lookups: "kafka OOMKill", "DNS resolution", "SSL certificate renewal"

**Embedding mode (opt-in):**

- When `llm.embedding_model` is configured in config, the extension generates an embedding for each digest
- At search time, embeds the query and does cosine similarity via pgvector
- Handles semantic queries: "that time kafka was acting weird" matches the OOMKill session even without exact keywords
- Falls back to full-text if the embedding call fails

#### The Tool

The extension registers a single tool:

```go
// internal/extensions/searchable_history/tools.go

type HistorySearchTool struct {
    db     *sql.DB
    embed  Embedder  // nil if no embedding model configured
    logger *slog.Logger
}

func (t *HistorySearchTool) Execute(ctx context.Context, args json.RawMessage, toolCtx ToolContext) (json.RawMessage, error) {
    var input struct {
        Query string `json:"query"`
        Limit int    `json:"limit,omitempty"` // default 5
    }
    json.Unmarshal(args, &input)
    if input.Limit == 0 {
        input.Limit = 5
    }

    if t.embed != nil {
        return t.searchByEmbedding(ctx, input.Query, input.Limit)
    }
    return t.searchByFTS(ctx, input.Query, input.Limit)
}
```

Search results return the top matching digests (default 5) — the actual messages from those sessions. The agent reads them and reasons through what's relevant. No summary, no interpretation. Just the raw messages.

#### Indexing Flow

```
Session completes
       │
       ▼
searchable_history subscribes to session completion events
       │
       ├── Load all events for the session
       ├── Build digest (strip tool calls/results/status, keep messages only)
       ├── Store digest in session_digests
       ├── Embedding configured?
       │     YES → generate embedding for digest → store in embedding column
       │     NO  → skip (full-text search works via digest_tsv)
       │
       ▼
Digest is searchable
```

#### Config

```yaml
extensions:
  searchable_history:
    enabled: true
    # No config needed. Detects embedding mode from llm.embedding_model.
    # Falls back to full-text search automatically.
```

#### Extension Init

```go
func (e *Extension) Init(ctx extension.ExtensionContext) error {
    e.db = ctx.DB

    // Run migration: create session_digests table
    if err := e.migrate(ctx.DB); err != nil {
        return fmt.Errorf("searchable_history migration failed: %w", err)
    }

    // Check if embedding mode should be enabled
    if cfg.LLM.EmbeddingModel != "" {
        embedder, err := NewLLMEmbedder(cfg.LLM.Endpoint, cfg.LLM.APIKey, cfg.LLM.EmbeddingModel)
        if err != nil {
            ctx.Logger.Warn("embedding setup failed, falling back to full-text", "error", err)
        } else {
            e.embed = embedder
        }
    }

    // Register tool
    ctx.Registry.Register(&HistorySearchTool{db: e.db, embed: e.embed, logger: ctx.Logger})

    return nil
}
```

---

## Directory Structure

```
beluga/
├── cmd/
│   ├── beluga/
│   │   └── main.go              # Main daemon entrypoint
│   └── remora/
│       └── main.go              # Remote daemon binary (runs on other hosts)
├── internal/
│   ├── core/
│   │   ├── agent/               # Agent loop (orchestrator)
│   │   │   ├── loop.go          # Run loop: build context → LLM → tools → repeat
│   │   │   ├── llm.go           # OpenAI-compatible client
│   │   │   └── context.go       # Event → message builder, skill injection, truncation
│   │   ├── session/             # Session CRUD
│   │   ├── eventstore/          # Append-only event log
│   │   ├── workspace/           # Docker sandbox manager
│   │   │   ├── manager.go       # Create, Get, Destroy, CleanupIdle
│   │   │   └── sandbox.go       # Exec, ReadFile, WriteFile
│   │   ├── tools/               # Tool registry + built-in workspace tools
│   │   │   ├── registry.go      # Thread-safe Tool interface registry
│   │   │   └── workspace.go     # workspace_exec, workspace_read_file, workspace_write_file
│   │   ├── model/               # Shared types (Session, Event, payloads)
│   │   └── extension/           # Extension manager
│   │       ├── manager.go       # Load, Init, Start, Stop extensions
│   │       └── context.go       # ExtensionContext struct
│   ├── extensions/              # Built-in extensions
│   │   ├── clickup/             # ClickUp connector + tools
│   │   │   ├── connector.go     # Poller: watch tasks/mentions → CreateSession
│   │   │   ├── client.go        # ClickUp REST API client
│   │   │   └── tools.go         # clickup_post_comment, etc.
│   │   ├── github/              # GitHub tools
│   │   │   ├── client.go        # GitHub App client (JWT, installation tokens)
│   │   │   └── tools.go         # push_to_branch, create_pr, etc.
│   │   ├── pipeline/            # Pipeline sandbox
│   │   │   ├── manager.go       # Redpanda → Logstash → ES lifecycle
│   │   │   ├── config.go        # Logstash config rewriting
│   │   │   └── tools.go         # send_data, query_es, etc.
│   │   ├── ext_host/            # gRPC server + remote extension host
│   │   │   ├── provider.go      # GRPCProvider: gRPC server, TLS, connection manager
│   │   │   ├── remote_ext.go    # Remote extension host gRPC service
│   │   │   └── proxy.go         # Tool call proxy to remote extension processes
│   │   ├── remora/              # Remote host daemon manager
│   │   │   ├── server.go        # gRPC server for remora daemon connections
│   │   │   └── tools.go         # host_exec, host_grep, host_cat, etc.
│   │   ├── evolving_skills/     # Evolving skills extension (file-based)
│   │   │   ├── extension.go     # Registers skill_search, skill_create tools
│   │   │   └── search.go        # grep/ripgrep-based skill search
│   │   ├── searchable_history/  # Searchable history extension
│   │   │   ├── extension.go     # Registers history_search tool
│   │   │   └── search.go        # Full-text or embedding-based search
│   │   └── slack/               # Slack connector + tools (future)
│   └── remora/                  # Remora daemon internals (used by cmd/remora)
│       ├── executor/            # Whitelisted command executor
│       ├── sync/                # Directory sync
│       └── client/              # gRPC client to Beluga core
├── proto/
│   ├── remora.proto             # gRPC service for remora daemon
│   └── extension_host.proto     # gRPC service for remote extensions
├── migrations/
│   └── 001_init_schema.sql      # PostgreSQL schema (sessions + events only)
├── configs/
│   └── beluga.yaml              # Main config with extension sections
├── .beluga/                     # Agent runtime data (created on first start)
│   ├── SYSTEM.md                # Base system prompt (user-editable)
│   ├── prompts/                 # Prompt templates from extensions
│   └── skills/                  # Skills (if evolving-skills extension enabled)
│       └── extension-builder/   # Built-in skill
│           ├── SKILL.md
│           └── prompt.md
├── deploy/
│   ├── docker/                  # Dockerfiles, compose files
│   └── ansible/                 # Deployment playbooks
├── go.mod
├── Makefile
└── PRD.md
```

---

## Extension Interface (Detail)

```go
package extension

// Extension is the interface all extensions implement.
type Extension interface {
    // Name returns the extension's identifier (used in config and logging).
    Name() string

    // Init is called once at startup. Use it to parse config, create clients,
    // register tools in the registry. Extensions that need gRPC
    // (like remora) register services on ctx.GRPC here.
    Init(ctx ExtensionContext) error

    // Start is called after all extensions have been initialized.
    // Use it to start background goroutines (connectors, listeners).
    // Must block until ctx is cancelled or Stop is called.
    Start(ctx context.Context) error

    // Stop is called on graceful shutdown. Clean up resources.
    Stop(ctx context.Context) error
}

// ExtensionContext is everything an extension gets access to.
type ExtensionContext struct {
    // Raw config from the YAML section matching the extension name.
    Config json.RawMessage

    // Core services the extension can use.
    Registry       *tools.Registry      // Register tools here
    Sessions       *session.Store       // Create/query sessions
    Events         *eventstore.Store    // Append/query events
    DB             *sql.DB              // Direct database access for custom queries/migrations
    Docker         *client.Client       // Create custom sandboxes
    Logger         *slog.Logger

    // PromptDir — path to .beluga/prompts/. Extensions can write
    // prompt template files here to inject behavioral context.
    PromptDir      string

    // GRPC — nil unless ext_host is enabled. Check before using.
    GRPC          *GRPCProvider         // provided by ext_host extension

    // CreateSession creates a new agent session from an external event.
    // Connectors call this when they detect a new task/mention/message.
    CreateSession  func(ctx context.Context, source, sourceID string, metadata json.RawMessage) (*model.Session, error)
}
```

### Startup Sequence

```go
// cmd/beluga/main.go (simplified)

func main() {
    cfg := loadConfig()

    // 1. Initialize core services.
    db := database.Connect(cfg.Database)
    sessions := session.NewStore(db)
    events := eventstore.NewStore(db)
    registry := tools.NewRegistry()
    docker := dockerClient.New()

    // 2. Register built-in workspace tools.
    tools.RegisterWorkspaceTools(registry)

    // 3. Ensure .beluga directory structure exists.
    os.MkdirAll(".beluga/prompts", 0755)
    os.MkdirAll(".beluga/skills", 0755)
    // If .beluga/SYSTEM.md doesn't exist, write the default.
    if _, err := os.Stat(".beluga/SYSTEM.md"); os.IsNotExist(err) {
        os.WriteFile(".beluga/SYSTEM.md", DefaultSystemPrompt, 0644)
    }

    // 4. The GRPCProvider is nil by default. The ext_host extension sets it
    //    during Init(). Extensions that need gRPC (like remora) check ctx.GRPC
    //    and fail with a clear error if it's nil.
    extCtx := extension.ExtensionContext{
        Registry:      registry,
        Sessions:      sessions,
        Events:        events,
        Docker:        docker,
        DB:            db,
        Logger:        logger,
        PromptDir:     ".beluga/prompts",
        GRPC:          nil,  // set by ext_host during Init()
        CreateSession: orchestrator.HandleNewSession,
    }

    // 4. Initialize enabled extensions in config order.
    //    ext_host must come first — it sets ctx.GRPC for later extensions.
    extMgr := extension.NewManager(logger)
    for name, ext := range builtinExtensions {
        if cfg.Extensions[name].Enabled {
            extCtx.Config = cfg.Extensions[name].Config
            extMgr.Register(ext, extCtx)
        }
    }
    extMgr.InitAll()   // calls Init() on each. ext_host sets ctx.GRPC here.

    // 6. Start extensions (connectors, listeners, gRPC server, etc.).
    extMgr.StartAll(ctx)

    // 7. Create agent loop with all registered tools.
    agent := agent.NewLoop(sessions, events, llmClient, registry, logger)

    // 8. Wait for shutdown signal.
    <-ctx.Done()
    extMgr.StopAll(ctx)
}
```

---

## Config Format

```yaml
# beluga.yaml

# LLM configuration (OpenAI-compatible endpoint)
llm:
  endpoint: "${LLM_ENDPOINT}"
  api_key: "${LLM_API_KEY}"
  model: "anthropic/claude-sonnet-4"
  # Embedding is optional. If configured, history search uses vector similarity.
  # If omitted, history search falls back to PostgreSQL full-text search.
  # Set automatically during onboarding if embedding models are detected.
  # embedding_model: "text-embedding-3-small"
  # embedding_dimensions: 1536

# PostgreSQL (pgvector extension optional — only needed for embedding-based history search)
database:
  url: "${DATABASE_URL}"
  max_connections: 20

# Workspace sandbox defaults
workspace:
  image: "beluga/agent-workspace:latest"
  cpu_limit: "1.0"
  memory_limit: "1g"
  idle_timeout: "1h"
  network_mode: "none" # no internet by default

# Agent behavior
agent:
  max_iterations: 30
  max_context_tokens: 128000
  # System prompt is .beluga/SYSTEM.md — edit it directly. No config needed.

# Extensions - each key maps to an extension name.
# The value is passed as json.RawMessage to the extension's Init().
# Order matters: ext_host must come before remora (remora needs gRPC).
extensions:
  ext_host:
    enabled: false
    address: ":50051"
    tls_cert: "${BELUGA_TLS_CERT}"
    tls_key: "${BELUGA_TLS_KEY}"
    # When enabled, provides the gRPC server for remora and remote extensions.

  clickup:
    enabled: true
    api_token: "${CLICKUP_API_TOKEN}"
    team_id: "9012345678"
    space_id: "90123456789"
    agent_username: "Beluga Agent"
    poll_interval: "30s"

  github:
    enabled: true
    app_id: 123456
    private_key: "${GITHUB_PRIVATE_KEY}"
    branch_prefix: "agent/"
    protected_refs: ["main", "master", "release/*"]

  pipeline:
    enabled: false
    redpanda_image: "docker.redpanda.com/redpandadata/redpanda:latest"
    elasticsearch_image: "docker.elastic.co/elasticsearch/elasticsearch:8.17.0"
    logstash_image: "docker.elastic.co/logstash/logstash:8.17.0"

  remora:
    enabled: false
    # Requires ext_host to be enabled

  slack:
    enabled: false
    bot_token: "${SLACK_BOT_TOKEN}"
    app_token: "${SLACK_APP_TOKEN}"

  evolving_skills:
    enabled: true
    # File-based skills in .beluga/skills/
    # Ships with extension-builder skill built in
    # Agents create skills automatically, humans can edit them directly

  searchable_history:
    enabled: true
    # Embedding is optional. If llm.embedding_model is configured,
    # uses vector similarity. Otherwise falls back to full-text search on events.
    # No extra setup required.
```

---

## Agent Loop

The agent loop is the heart of Beluga. It runs for each active session:

```
1. Load session events from event store
2. If a compacted summary exists, use it as context base
3. Convert events to LLM messages (user, assistant, tool_call, tool_result)
4. Assemble system prompt: SYSTEM.md + extension prompts + relevant skill prompts
5. Truncate if approaching token limit (compact if needed)
6. Call LLM with messages + tool definitions
7. If tool calls:
   a. Record tool_call event
   b. Execute tool via registry
   c. Record tool_result event
   d. Go to step 1
8. If text response:
   a. Record agent_message event
   b. Session completes or suspends
```

The loop is deliberately simple. It's an iteration counter with tool dispatch. Extensions don't modify the loop - they modify what tools are available.

---

## What Beluga Does NOT Do

- **No UI (for now).** Beluga is a daemon. Interactions happen through connectors (ClickUp, Slack) or API. Maybe there will be a UI in the future.
- **No multi-model routing.** One LLM endpoint. (Could be an extension later.)
- **No user management.** Single-organization deployment. (Auth is handled by connectors.)

---

First-party extensions:

- **Evolving Skills** — agents create and search skills (file-based, bundled with prompt templates)
- **Searchable History** — search past sessions (full-text by default, embedding-based if configured)
- GitHub
- Clickup
- Remote Extensions (ext_host)
- Remora
- Pipeline Sandbox

## Migration from Ivy

Ivy is a working implementation of a Beluga managed agent. Here's how Ivy's components map:

| Ivy Component          | Beluga Equivalent                                                 |
| ---------------------- | ----------------------------------------------------------------- |
| vine binary            | beluga binary (core)                                              |
| vine orchestrator      | core/agent/loop                                                   |
| vine session store     | core/session                                                      |
| vine event store       | core/eventstore                                                   |
| vine sandbox manager   | core/workspace                                                    |
| vine tool registry     | core/tools/registry                                               |
| vine sandbox tools     | core/tools/workspace (built-in)                                   |
| vine skills store      | extensions/evolving_skills (file-based skills + prompt templates) |
| vine history store     | extensions/searchable_history (full-text + optional embedding)    |
| vine connector/clickup | extensions/clickup (connector + tools)                            |
| vine connector/github  | extensions/github (tools only)                                    |
| vine pipeline sandbox  | extensions/pipeline (sandbox provider + tools)                    |
| vine leafmgr           | extensions/remora (host provider, needs ext_host)                 |
| leaf binary            | cmd/remora/ (remote daemon binary)                                |
| leaf commands          | internal/remora/executor                                          |
| leaf sync              | internal/remora/sync                                              |
| leaf grpc client       | internal/remora/client                                            |

---

## Building a New Extension

Here's how simple it should be to add a new extension:

```go
// internal/extensions/jira/jira.go
package jira

type Extension struct {
    client *jira.Client
    registry *tools.Registry
    logger  *slog.Logger
}

func (e *Extension) Name() string { return "jira" }

func (e *Extension) Init(ctx extension.ExtensionContext) error {
    // Parse config
    var cfg struct {
        Host      string `json:"host"`
        APIToken  string `json:"api_token"`
        Email     string `json:"email"`
    }
    if err := json.Unmarshal(ctx.Config, &cfg); err != nil {
        return err
    }

    // Create client
    e.client = jira.NewClient(cfg.Host, cfg.Email, cfg.APIToken)
    e.registry = ctx.Registry
    e.logger = ctx.Logger

    // Register tools
    e.registry.Register(&GetIssueTool{Client: e.client})
    e.registry.Register(&AddCommentTool{Client: e.client})
    e.registry.Register(&SearchIssuesTool{Client: e.client})

    return nil
}

func (e *Extension) Start(ctx context.Context) error {
    // No background process needed - tools only
    <-ctx.Done()
    return nil
}

func (e *Extension) Stop(ctx context.Context) error {
    return nil
}
```

Then register it in `cmd/beluga/main.go`:

```go
extension.Register("jira", &jira.Extension{})
```

And add config:

```yaml
extensions:
  jira:
    enabled: true
    host: "https://yourorg.atlassian.net"
    api_token: "${JIRA_API_TOKEN}"
    email: "agent@yourorg.com"
```

That's it. Three tools are now available to every managed agent session.

---

## The `beluga` CLI

Beluga ships as a single binary that serves as both the daemon and the management CLI.

```
beluga onboard                        # Onboard Beluga
beluga start                          # Start the daemon (blocks)
beluga start --detach                 # Start as background service
beluga stop                           # Graceful shutdown
beluga status                         # Show running sessions, extensions, connected hosts

beluga extend create <name> [--type local|remote]
                                      # Scaffold a new extension
beluga extend verify <path>           # Compile, test, validate tool schemas
beluga extend install <path>          # Install extension (rebuild + restart for local)
```

The `extend` subcommands are what agents use when building extensions. They're also available to human developers who want to scaffold and test by hand.

---

## Building Extensions with Agents

Beluga agents can build their own extensions. This is a built-in skill - every Beluga agent knows how to scaffold, test, and install extensions.

### How It Works

The agent develops extensions inside its workspace sandbox. The workspace image includes the Go toolchain and the Beluga module dependencies, so the agent can write, compile, and test extension code locally without network access.

Three CLI commands make this possible:

```
beluga extend create <name> [--type local|remote]
beluga extend verify <path>
beluga extend install <path>
```

**`beluga extend create`** - scaffolds an extension directory with boilerplate. The agent starts from a working skeleton instead of writing from scratch.

```
my-jira/
├── extension.go      # Implements Extension interface
├── tools.go          # Tool definitions and execution
├── extension_test.go # Skeleton test with VerifyTools helper
├── config.yaml       # Example config
└── README.md         # What this extension does
```

**`beluga extend verify`** - the feedback loop. Compiles the extension, runs its tests, validates every tool definition (name, JSON schema, description), and optionally attempts a dry-run of each tool with mock inputs. Returns a structured report:

```json
{
  "compiles": true,
  "tests_pass": true,
  "tools": [
    { "name": "jira_get_issue", "schema_valid": true, "dry_run": "passed" },
    { "name": "jira_search", "schema_valid": true, "dry_run": "passed" }
  ],
  "errors": []
}
```

The agent runs `verify` repeatedly as it develops. If a tool schema is invalid or a dry-run fails, the agent gets a concrete error it can fix - no hallucinating.

**`beluga extend install`** - registers the extension with Beluga. For local extensions, this rebuilds the Beluga binary with the new extension compiled in, then gracefully restarts. For remote extensions, this starts the extension process which connects via gRPC. Active sessions are suspended and resume after restart.

### The Verification Loop

The problem with agents writing code is they can't see if it actually works. The `verify` command solves this with three checks:

1. **Compile check** - does the code build? Catches syntax errors, wrong types, missing imports.
2. **Schema validation** - is every tool's JSON Schema valid? Does every required field have a description? Does the schema match what `Execute()` actually expects?
3. **Dry-run** - for each tool, `verify` calls `Execute()` with a mock `ToolContext` and synthetic args. The extension author provides a test mode that returns a canned response instead of hitting a real API. This catches argument parsing bugs, nil pointer errors, and wrong return formats.

The agent writes code → runs `verify` → reads the structured output → fixes errors → repeats. This is the same loop a human developer follows, but the agent does it autonomously.

### Built-in Skill: extension-builder

Every Beluga agent has a built-in skill called `extension-builder` that teaches it:

- The `Extension` interface and what each method does
- How to write tool definitions with valid JSON Schema
- How to use `ToolContext` (accessing the workspace sandbox, session ID, etc.)
- How to write dry-run mocks for `verify`
- When to use each extension pattern (connector, tools-only, sandbox provider, host provider)
- How to write the config section for the new extension
- The exact `beluga extend` commands to scaffold, verify, and install

This skill is injected into the agent's system prompt when it recognizes the user is asking for a new capability. The agent doesn't need to guess - it follows the pattern.

### Example: Agent Builds a Jira Extension

```
User (via ClickUp): "@Beluga Agent I need to be able to search and comment on Jira tickets. Can you set that up?"

Agent:
  1. Recognizes this as an extension request
  2. Searches skills → finds extension-builder skill
  3. Runs: beluga extend create jira --type local
  4. Fills in tools: jira_get_issue, jira_search, jira_add_comment
  5. Writes the Jira client, tool definitions, dry-run mocks
  6. Runs: beluga extend verify ./jira
     → compile: ok, schema: ok, dry-run: 3/3 passed
  7. Runs: beluga extend install ./jira
     → Beluga rebuilds, restarts, Jira extension is live
  8. Posts back to ClickUp: "Done. I've installed the Jira extension. You'll
     need to add your Jira API token to the config. Here's what to add..."
```

### Local vs Remote Development

**Local extensions** (compiled into the binary):

- Agent writes Go code in the workspace
- `verify` compiles and tests inside the workspace (Go toolchain is included)
- `install` copies the extension into Beluga's extension directory, rebuilds the binary, restarts Beluga
- The workspace has the Beluga module available as a local dependency so imports resolve

**Remote extensions** (separate process connecting via gRPC):

- Agent writes the extension in any language
- `verify` validates tool schemas against the protobuf spec and runs the process briefly to confirm it connects and registers
- `install` starts the extension process as a systemd unit or Docker container
- No Beluga restart needed — the process just connects to ext_host's gRPC server

In both cases the agent uses the same `verify` command and gets the same structured feedback. The only difference is what `install` does at the end.

---

## Phase Plan

### Phase 1: Core Runtime

- Project scaffolding (Go module, Makefile, directory structure)
- PostgreSQL schema (sessions, events only)
- Session store + event store
- Tool registry + built-in workspace tools
- Docker workspace manager (create, exec, read/edit file, destroy, idle cleanup)
- Prompt assembler (SYSTEM.md + prompts/ + skills/\*/prompt.md)
- Agent loop (orchestrator + LLM client + context builder + compactor)
- Extension manager (interface + config-driven loading)
- `.beluga/` directory setup with default SYSTEM.md
- Onboarding flow (LLM setup, connector setup)
- `beluga` CLI: start, stop, status

### Phase 2: Extension Tooling

- `beluga extend create` - scaffold extension boilerplate (local + remote)
- `beluga extend verify` - compile, test, schema validation, dry-run harness
- `beluga extend install` - install local extension (rebuild + restart) and remote extension (start process)
- extension-builder built-in skill (in .beluga/skills/)
- Workspace image with Go toolchain and Beluga module deps
- Extension verification harness (ToolContext mock, dry-run protocol)

### Phase 3: First Extensions (Ported from Ivy)

- Evolving skills extension (file-based skills in .beluga/skills/ with prompt templates)
- Searchable history extension (full-text by default, embedding-based if configured)
- ClickUp extension (connector + tools)
- GitHub extension (tools only)
- Pipeline extension (sandbox provider + tools)

### Phase 4: Remote Daemon

- Remora daemon binary (whitelisted executor, directory sync, gRPC client)
- Remora extension (gRPC server provided by ext_host, connection manager, host tools)
- Ansible deployment playbooks

### Phase 5: Polish & Documentation

- End-to-end integration tests
- Extension authoring guide
- API reference
- Example extensions (Jira, Slack stub, webhook connector)
