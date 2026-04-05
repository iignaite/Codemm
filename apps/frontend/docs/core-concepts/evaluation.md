# Deprecated

This document is deprecated and should not be used as implementation guidance.

It described an older Codemm shape based on HTTP endpoints, SSE generation streams, auth/profile/community concepts, or legacy `/sessions/*` flows. The current repository does not use that architecture.

Current frontend architecture:
- the renderer talks to the backend through the preload bridge and Electron main only
- UI state is local to the desktop app and workspace-scoped
- thread, activity, judge, and LLM flows use the IPC bridge instead of direct HTTP requests
- there are no active auth, profile, or community flows in the desktop product

Use these current documents instead:
- `docs/ARCHITECTURE.md`
- `docs/FUNCTIONS.md`
- `docs/TROUBLESHOOTING.md`
- `apps/frontend/docs/architecture.md`
- `apps/frontend/docs/data-flow.md`

If this topic still needs app-local documentation, replace this stub with a source-first document that matches the current IPC-based desktop implementation.
