# beluga

🐋 Managed Agents that grow with you.

Beluga is a framework for building managed agents — autonomous agents that run in sandboxed workspaces, can be extended with new capabilities, and compound their knowledge over time. Agents can build and install their own extensions.

## Core Concepts

| Primitive     | What it does                                             |
| ------------- | -------------------------------------------------------- |
| **Session**   | Durable agent interaction with append-only event log     |
| **Workspace** | Docker sandbox for code execution, file I/O              |
| **Tool**      | Function the agent can call (extensible via extensions)  |
| **Skill**     | Learned pattern with vector search (compounds over time) |
| **Extension** | Bundle that adds connectors, tools, or sandbox types     |

## Extensions

Extensions add domain-specific capabilities. Each can provide:

- **Connector** — triggers sessions from external events (ClickUp, Slack, webhooks)
- **Tool Provider** — registers tools the agent can use (GitHub, Jira, custom APIs)
- **Sandbox Provider** — creates specialized environments (data pipelines, databases)
- **Host Provider** — connects to remote daemons on other machines

Agents build their own extensions using `beluga extend create|verify|install`.
