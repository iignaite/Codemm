# Contributing

Thanks for helping. Codemm stays small on purpose, so read [AGENTS.md](AGENTS.md) for the invariants and [docs/DESIGN.md](docs/DESIGN.md) for the spec before you start.

## Set up

You need Node.js 22+ and Docker Desktop (running) for the full suite.

```bash
npm ci
npm run typecheck
npm test
```

`npm run test:unit` skips the Docker tests.

## Layout

```
src/        the CLI, MCP server and core modules
test/       unit tests; test/docker/ needs a container runtime
test/fixtures/
  tracks/      shell-script tracks used only by Codemm's own tests
  exercises/   fixture exercises for the gates
docs/       design, security, migration
```

## Pull requests

- Write the test first, and keep each PR to one change.
- Run `npm run typecheck` and `npm test` before you push. CI runs both on Linux with Docker.
- If you change a format or a gate, update `docs/DESIGN.md` in the same PR.
- Security issues: please report them privately to the maintainers rather than in a public issue.
