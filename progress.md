# Beluga Extension Rewrite Progress

## Completed

- [x] **@beluga/sdk package** (`packages/sdk/`) — all extension types, tool interfaces, domain types, GRPCProvider interface, proto file
- [x] **beluga core** — re-exports from @beluga/sdk, `shared` field on ExtensionContext, bun workspaces configured
- [x] **beluga-ext-host** (`/Users/collinpfeifer/GitHub/beluga-ext-host/`) — gRPC server, ExtensionHostService, GRPCProviderImpl, proto loaded at runtime. Go files preserved. `bun run check` passes.

## In Progress

- [x] **beluga-ext-remora** (`/Users/collinpfeifer/GitHub/beluga-ext-remora/`) — TS rewrite complete. 7 host tools, RemoraManager, RemoraService gRPC. `tsc --noEmit` passes. Go files preserved.
- [ ] **beluga-ext-clickup** — needs TS rewrite importing from @beluga/sdk
- [ ] **beluga-ext-github** — needs TS rewrite importing from @beluga/sdk
- [ ] **beluga-ext-history** — needs TS rewrite importing from @beluga/sdk
- [x] **beluga-ext-pipeline** — TS rewrite complete. 5 tools, PipelineManager, Docker sandboxes. `tsc --noEmit` passes. Go files preserved.
- [ ] **beluga-ext-skills** — needs TS rewrite importing from @beluga/sdk

## Remaining

- [ ] Remove `src/extensions/` from beluga core (currently has bundled copies)
- [ ] Remove `loadBundledExtensions` from loader
- [ ] Update beluga loader to only scan `.beluga/extensions/`
- [ ] Each extension repo gets its own `package.json`, `tsconfig.json`, `extension.json`, `index.ts`
