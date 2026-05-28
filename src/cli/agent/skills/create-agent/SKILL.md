# Create Agent Skill

## Purpose

Guidance for creating and installing new Beluga agents. Use this skill when a user asks you to create a new agent, set up a new specialized assistant, or add a new agent to the Beluga instance.

## Creating a New Agent

### 1. Scaffold the agent

```bash
beluga agent create <agent-name> [--from <template-agent>] [-o <output-dir>]
```

- Default output: `.beluga/agents/`
- `--from` copies an existing agent's manifest and system prompt as a starting point
- Creates `<dir>/<agent-name>/` containing:
  - `agent.json` — agent manifest
  - `SYSTEM.md` — system prompt

### 2. Agent manifest (agent.json)

```json
{
  "name": "my-agent",
  "version": "0.1.0",
  "description": "What this agent does",
  "systemPrompt": "SYSTEM.md",
  "extensions": [
    "extension-name"
  ],
  "extensionSources": {
    "extension-name": "https://github.com/org/beluga-ext-extension"
  },
  "model": {
    "endpoint": "https://api.openai.com/v1",
    "apiKey": "${MY_AGENT_API_KEY}",
    "model": "gpt-4o"
  },
  "maxIterations": 30,
  "maxContextTokens": 128000,
  "config": []
}
```

#### Required fields
- `name` — unique agent identifier (kebab-case)
- `systemPrompt` — path to system prompt markdown file (relative to agent dir)

#### Optional fields
- `extensions` — list of extension names this agent should have access to
- `extensionSources` — maps extension name → git URL for auto-install
- `model` — override global LLM config (endpoint, apiKey, model, embeddingModel, embeddingDimensions)
- `maxIterations` — max agent loop iterations (default: 30)
- `maxContextTokens` — context window size (default: 128000)

### 3. Write the system prompt

Edit `SYSTEM.md` to define the agent's behavior, personality, and capabilities. This is the system message sent to the LLM on every session.

### 4. Install the agent

If the agent was created outside `.beluga/agents/`:

```bash
beluga agent install ./path/to/agent-dir
```

Or from a git repo:

```bash
beluga agent install https://github.com/org/beluga-agent-name
```

Install automatically:
- Copies agent files to `.beluga/agents/<name>/`
- Auto-installs missing extensions listed in `extensionSources`
- Updates `.beluga/config.json` with the agent entry

### 5. Verify

```bash
beluga agent verify .beluga/agents/<name>
```

Checks manifest validity and type-checks the entrypoint if present.

### 6. Enable in routing

In `.beluga/config.json`, add a routing rule:

```json
{
  "routing": {
    "_default": "default",
    "slack:channel-id": "my-agent",
    "webhook:custom": "my-agent"
  }
}
```

### 7. Restart Beluga

```bash
beluga start
```

## Key Concepts

- **Agents are isolated**: Each agent has its own sessions, history, skills, extensions, and tools
- **Per-agent scoping**: Sessions include an `agent` column; history search and skill tools are scoped to the invoking agent
- **Extensions are shared**: Extensions are installed once in `.beluga/extensions/` but tools are filtered per-agent based on the `extensions` list in `agent.json`
- **Model overrides**: Each agent can use a different LLM endpoint/model without affecting others
