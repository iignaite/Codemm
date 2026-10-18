/**
 * What kind of failure an error is, for callers that act on it (the desktop) without reading the message:
 * no course yet, a track image that needs a rebuild, a damaged record, a file changed outside Codemm, or this
 * computer's Docker, disk or network.
 */
export type ErrorKind = "no-course" | "image-missing" | "damaged" | "changed" | "docker" | "disk" | "offline";

/** An error whose message is safe and useful to show to a learner or an agent. */
export class CodemmError extends Error {
  override name = "CodemmError";
  constructor(message: string, readonly kind?: ErrorKind) {
    super(message);
  }
}
