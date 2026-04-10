# V1 Agent Workflow (`07f136a52e5bab02e45f90c1b26f849224d87864`)

```mermaid
flowchart TD
  A["User request"] --> B["threads.postMessage<br/>ipcServer.ts"]
  B --> C["processSessionMessage()<br/>sessionService.ts"]
  C --> D["Load spec/history/collector/commitments<br/>threadDb + threadMessageDb + threadCollectorDb"]
  D --> E["runDialogueTurn()<br/>dialogueService.ts"]
  E --> F{"Deterministic parse enough?"}
  F -- "No" --> G["createCodemmCompletion()<br/>codemmProvider.ts"]
  G --> H["Parse JSON patch"]
  F -- "Yes" --> H
  H --> I["Persist spec, confidence, collector, intent trace"]
  I --> J{"Spec complete?"}
  J -- "No" --> K["Return nextQuestion / confirmation"]
  J -- "Yes" --> L["threads.generate<br/>generateFromSession()"]

  L --> M["Validate ActivitySpec + deriveProblemPlan()"]
  M --> N["Sequential slot loop<br/>generateProblemsFromPlan()"]
  N --> O["generateSingleProblem()<br/>one LLM call returns full draft JSON"]
  O --> P["Schema checks + language-specific repairs<br/>perSlotGenerator.ts"]
  P --> Q["validateReferenceSolution()<br/>Docker judge"]
  Q --> R["runTestStrengthGate()"]
  R --> S{"Slot succeeded?"}
  S -- "Yes" --> T["Discard reference artifacts + checkpoint threadDb"]
  T --> U{"More slots?"}
  U -- "Yes" --> N
  U -- "No" --> V["activityDb.create() + state SAVED"]

  S -- "No after 3 slot attempts" --> W["GenerationSlotFailureError"]
  W --> X["Checkpoint problems/outcomes"]
  X --> Y{"Fallback available?"}
  Y -- "Yes" --> Z["proposeGenerationFallbackWithPolicy()<br/>patch spec + replan remaining slots"]
  Z --> N
  Y -- "No" --> AA["state READY + generation_failed"]

  V --> AB["Return activityId + problems"]
```

- `processSessionMessage()` builds context from persisted thread state, then `runDialogueTurn()` either uses deterministic parsing or calls the LLM once to produce a partial spec patch.
- `generateFromSession()` runs only after the spec is complete and valid, then calls `deriveProblemPlan()` once and processes slots sequentially.
- `generateSingleProblem()` is the main agent step: one prompt returns the full draft, including tests and hidden reference artifacts, before Docker validation.
- Failure handling is slot-centric: `generateProblemsFromPlan()` retries a slot up to 3 times and can pass repair context back into `generateSingleProblem()`.
- Session-level fallback happens as soon as one slot hard-fails: `generateFromSession()` can patch the spec, replan, and continue from checkpointed successful slots.
