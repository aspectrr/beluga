# Extension Builder Skill

This skill teaches you how to build, verify, and install extensions for Beluga.

## The Extension Interface

Every extension implements this interface:

```go
type Extension interface {
    Name() string
    Init(ctx ExtensionContext) error
    Start(ctx context.Context) error
    Stop(ctx context.Context) error
}
```

- **Name()** returns the extension's identifier (used in config and logging).
- **Init()** is called once at startup. Parse config, create clients, register tools here.
- **Start()** is called after all extensions are initialized. Start background goroutines (connectors, listeners) here. Must block until context is cancelled.
- **Stop()** is called on graceful shutdown. Clean up resources.

## ExtensionContext

Everything an extension gets access to:

```go
type ExtensionContext struct {
    Config       json.RawMessage       // extension-specific config from yaml
    Registry     *tools.Registry       // register tools here
    Sessions     *session.Store        // create/query sessions
    Events       *eventstore.Store     // append/query events
    DB           *pgxpool.Pool         // direct database access for custom queries/migrations
    Docker       interface{}           // Docker client (nil if not needed)
    Logger       *slog.Logger
    PromptDir    string                // path to .beluga/prompts/ for writing prompt templates
    GRPC         interface{}           // nil unless ext_host extension is enabled
    CreateSession func(ctx context.Context, source, sourceID string, metadata json.RawMessage) (*model.Session, error)
}
```

## Tool Definitions

Tools are defined by a JSON Schema and executed by the runtime:

```go
type Tool interface {
    Definition() ToolDef
    Execute(ctx context.Context, args json.RawMessage, tctx ToolContext) (json.RawMessage, error)
}

type ToolDef struct {
    Name        string
    Description string
    Parameters  json.RawMessage  // JSON Schema object
}
```

### Writing a Tool

```go
type MyTool struct {
    client *MyClient
}

func (t *MyTool) Definition() tools.ToolDef {
    return tools.ToolDef{
        Name:        "my_tool",
        Description: "Does something useful",
        Parameters:  json.RawMessage(`{
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query"
                }
            },
            "required": ["query"]
        }`),
    }
}

func (t *MyTool) Execute(ctx context.Context, args json.RawMessage, tctx tools.ToolContext) (json.RawMessage, error) {
    var input struct {
        Query string `json:"query"`
    }
    if err := json.Unmarshal(args, &input); err != nil {
        return nil, fmt.Errorf("parsing args: %w", err)
    }

    result, err := t.client.Search(ctx, input.Query)
    if err != nil {
        return nil, err
    }

    return json.Marshal(result)
}
```

### JSON Schema Rules

- Always include `"description"` on every property
- Always list `"required"` fields
- Use specific types: `"string"`, `"integer"`, `"boolean"`, `"array"`, `"object"`
- For enums: `{"type": "string", "enum": ["option1", "option2"]}`
- For arrays: `{"type": "array", "items": {"type": "string"}}`

## ToolContext

```go
type ToolContext struct {
    SessionID  string
    Sandbox    SandboxRunner  // nil unless workspace is running
    EventStore *eventstore.Store
}
```

- **SessionID** — the current session, useful for logging
- **Sandbox** — the workspace sandbox (if one is running). Use for workspace operations.
- **EventStore** — append events to the session log

## Dry-Run Mocks

Every tool should support a dry-run mode for `beluga extend verify`. The pattern:

```go
func (t *MyTool) Execute(ctx context.Context, args json.RawMessage, tctx tools.ToolContext) (json.RawMessage, error) {
    var input struct {
        Query string `json:"query"`
    }
    if err := json.Unmarshal(args, &input); err != nil {
        return nil, fmt.Errorf("parsing args: %w", err)
    }

    // Dry-run mode: return canned response
    if os.Getenv("BELUGA_DRY_RUN") == "true" {
        return json.Marshal(map[string]interface{}{
            "results": []string{"mock result 1", "mock result 2"},
            "query":   input.Query,
        })
    }

    // Real execution
    return t.client.Search(ctx, input.Query)
}
```

## Extension Patterns

### Pattern 1: Connector + Tools

For extensions that trigger sessions from external events AND provide tools.

```go
func (e *Extension) Init(ctx extension.ExtensionContext) error {
    // Create API client
    e.client = NewClient(ctx.Config)
    // Register tools for interacting back
    ctx.Registry.Register(&PostCommentTool{Client: e.client})
    return nil
}

func (e *Extension) Start(ctx context.Context) error {
    // Start poller/listener goroutine
    go e.poller.Run(ctx, func(event Event) {
        sess, _ := e.createSession(ctx, event)
        // ...
    })
    <-ctx.Done()
    return nil
}
```

### Pattern 2: Tools Only

No background process. Just registers tools.

```go
func (e *Extension) Start(ctx context.Context) error {
    <-ctx.Done() // block until shutdown
    return nil
}
```

### Pattern 3: Sandbox Provider + Tools

Creates specialized sandbox environments.

### Pattern 4: Host Provider + Tools

Manages remote daemons. Requires `ext_host` for gRPC.

## The beluga extend Commands

### Scaffold a new extension:

```bash
beluga extend create <name> --type local
```

Creates: extension.go, tools.go, extension_test.go, config.yaml, README.md

### Verify an extension:

```bash
beluga extend verify ./<name>
```

Returns JSON: `{compiles, tests_pass, tools: [{name, schema_valid, dry_run}], errors}`

### Install an extension:

```bash
beluga extend install ./<name>
```

Copies into internal/extensions/, rebuilds, prints restart instructions.

## Config

Extensions are configured in `beluga.yaml`:

```yaml
extensions:
  my_extension:
    enabled: true
    api_token: "${MY_API_TOKEN}"
    # any key/value pairs — passed as json.RawMessage to Init()
```

Access in Init():

```go
var cfg struct {
    APIToken string `json:"api_token"`
}
json.Unmarshal(ctx.Config, &cfg)
```

## Writing Prompt Templates

Extensions can contribute to the system prompt by writing a markdown file to PromptDir:

```go
func (e *Extension) Init(ctx extension.ExtensionContext) error {
    // Write a prompt template
    promptPath := filepath.Join(ctx.PromptDir, "my_extension.md")
    os.WriteFile(promptPath, []byte("When using my_extension tools, always check permissions first."), 0644)
    return nil
}
```

This prompt gets appended to SYSTEM.md and injected into the agent's context.
