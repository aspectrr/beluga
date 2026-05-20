When building extensions, follow these rules:

1. Always use `beluga extend create <name> --type local` to start from the scaffold — don't write from scratch.
2. Every tool must have a valid JSON Schema with descriptions on every property and required fields listed.
3. Every tool must support dry-run mode (check `BELUGA_DRY_RUN` env var) and return a canned response.
4. After writing code, always run `beluga extend verify ./<name>` and read the structured output. Fix any errors before continuing.
5. Only run `beluga extend install` after verify passes cleanly.
6. If the extension needs a background process (connector, listener), use Pattern 1 and start the goroutine in `Start()`, not `Init()`.
7. If the extension only adds tools, use Pattern 2 and block in `Start()` with `<-ctx.Done()`.
8. Parse config in `Init()`, not in the constructor.
9. Write a prompt template to PromptDir if the extension adds behavioral context the agent needs.
10. The agent cannot see tool output — if the extension connects to an external service, the agent must post back through a tool (e.g. `post_comment`).
