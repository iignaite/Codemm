/**
 * What kind of failure an error is, for callers that act on it (the desktop) without reading the message:
 * no course yet, a track image that needs a rebuild, a damaged record, a file changed outside Codemm, or this
 * computer's Docker, disk or network.
 */
export type ErrorKind = "no-course" | "image-missing" | "damaged" | "changed" | "docker" | "disk" | "offline";

/**
 * Which of this computer's problems an infrastructure error is, as a stable code, and its kind. Callers act on the
 * code, never the wording: the desktop in-process, and over MCP, where the tool result's first line is
 * `codemm:<code>` (mcp.ts). Docker that isn't there or isn't running; Docker that is up but not answering; Docker that
 * answers but refused or failed; Docker's disk or this computer's; the network.
 */
export const INFRA = {
  "no-runtime": "docker",
  "no-wasmtime": "docker",
  "runtime-down": "docker",
  "runtime-paused": "docker",
  "socket-permission": "docker",
  "runtime-context": "docker",
  "runtime-busy": "docker",
  "check-timeout": "docker",
  "container-remove": "docker",
  "windows-containers": "docker",
  credentials: "docker",
  "container-start": "docker",
  "docker-cpus": "docker",
  "docker-log-driver": "docker",
  "docker-file-sharing": "docker",
  "runtime-failed": "docker",
  "image-id": "docker",
  "image-inspect": "docker",
  "container-list": "docker",
  "docker-disk": "disk",
  "host-disk": "disk",
  offline: "offline",
  "rate-limit": "offline",
  tls: "offline",
  "network-timeout": "offline",
} as const satisfies Record<string, ErrorKind>;
export type InfraCode = keyof typeof INFRA;

/** An error whose message is safe and useful to show to a learner or an agent. */
export class CodemmError extends Error {
  override name = "CodemmError";
  constructor(message: string, readonly kind?: ErrorKind, readonly code?: InfraCode) {
    super(message);
  }
}

/** This computer's problem: its kind follows from its code. */
export const infraError = (message: string, code: InfraCode) => new CodemmError(message, INFRA[code], code);
