# Codemm docs

| Doc | What's in it |
|---|---|
| [architecture.md](architecture.md) | How Codemm is built, with diagrams: the parts, the data model, use cases, main types, two flows and the security model |
| [DESIGN.md](DESIGN.md) | The 1.0 core spec: formats, gates, grading, mastery and the review log |
| [desktop/DESIGN.md](desktop/DESIGN.md) | The desktop app: architecture, the agent bridge, failure states and acceptance criteria (D1 to D21) |
| [desktop/beta-plan.md](desktop/beta-plan.md) | The private beta: who, consent, tasks and exit criteria |
| [bench/results.md](bench/results.md) | The cross-model bench of the terminal flow, and the minimum model per agent |
| [SECURITY.md](SECURITY.md) | The sandbox, trust boundaries and known limitations |
| [MIGRATION.md](MIGRATION.md) | Moving from Codemm v1: what changed, where v1 data lives, how to roll back |
| [release-evidence-1.0.md](release-evidence-1.0.md) | Recorded end-to-end runs behind the 1.0 release |
| [brand/](brand/README.md) | Logo, Emm the chameleon, and colors |
| [handoff/](handoff/) | Dated working notes from development sessions |

## No Docker? (school or work computers)

The desktop app runs io practice in interpreted languages without Docker or admin rights, in a WebAssembly sandbox ([DESIGN §4.5](DESIGN.md#45-the-wasi-engine-no-docker)). For everything else, ask whoever manages the computer to install Docker Desktop once, or use a computer that has Docker. See [No Docker?](../README.md#no-docker-school-or-work-computers) in the main README.

For an overview and install steps, see the [main README](../README.md). To contribute, see [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).
