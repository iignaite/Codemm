# Deprecated

This document is deprecated and should not be used as implementation guidance.

It described an older Codemm backend shape based on Express routes, SSE generation streams, auth/profile/community endpoints, or legacy `/sessions/*` flows. The current repository does not use that architecture.

Current backend architecture:
- renderer access is IPC-only through preload -> Electron main -> backend child process
- durable state is local-only per workspace
- backend methods are exposed as `threads.*`, `activities.*`, `judge.*`, and `engine.*`
- no auth, profile, community, or remote HTTP API surface is active by default

Use these current documents instead:
- `docs/ARCHITECTURE.md`
- `docs/FUNCTIONS.md`
- `docs/TROUBLESHOOTING.md`
- `apps/backend/docs/api/backend.md`

If this topic still needs app-local documentation, replace this stub with a source-first document that matches the current IPC-based desktop implementation.
