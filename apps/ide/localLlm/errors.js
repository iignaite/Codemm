class LocalLlmError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.name = "LocalLlmError";
    this.code = code;
    this.stage = opts.stage || null;
    this.recoverable = opts.recoverable !== false;
    this.detail = opts.detail || null;
    this.cause = opts.cause;
  }
}

function asLocalLlmError(err, fallback) {
  if (err instanceof LocalLlmError) return err;
  const message = err && err.message ? String(err.message) : fallback.message;
  return new LocalLlmError(fallback.code, message, {
    stage: fallback.stage,
    recoverable: fallback.recoverable,
    detail: fallback.detail,
    cause: err,
  });
}

module.exports = {
  LocalLlmError,
  asLocalLlmError,
};
