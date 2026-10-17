# Tutor fixtures

Agent-written tracks and gated exercises kept from the first bench run, so `--journey tutor` gives every model the same exercise. They are bench data, not part of Codemm, and are never packaged.

- `c/`: Claude Opus's C track (Alpine, `io`) and the `hello-number-echo` exercise.
- `python/`: Claude Opus's Python track (pytest, `unit`) and the `clamp-number` exercise.

Each folder holds `track/`, `roadmap.yaml` and `exercise/`, exactly as they were saved through `save_track`, `save_roadmap` and `save_exercise`.
