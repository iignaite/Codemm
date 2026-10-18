/**
 * Codemm's use cases. The CLI and the MCP server are thin wrappers around these.
 * `ws` is always an absolute workspace path. Course-scoped use cases take an optional `bound` course,
 * which replaces the workspace's active one (`codemm mcp --course`).
 */

export * from "./app/tracks.js";
export * from "./app/roadmaps.js";
export * from "./app/lessons.js";
export * from "./app/exercises.js";
export * from "./app/progress.js";
