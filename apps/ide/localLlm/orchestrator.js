const crypto = require("crypto");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { LocalLlmError, asLocalLlmError } = require("./errors");
const { probeHostCapabilities } = require("./hostCapabilityProbe");
const { resolveCandidateProfiles } = require("./modelCatalog");
const { localRuntimePlugin } = require("./plugins/localRuntime");

const runtimeDriver = localRuntimePlugin.driver;

const READY_TTL_MS = 15_000;

const VALID_TRANSITIONS = new Map([
  ["NOT_INSTALLED", new Set(["INSTALLING", "INSTALLED", "FAILED"])],
  ["INSTALLING", new Set(["INSTALLED", "FAILED"])],
  ["INSTALLED", new Set(["STARTING", "FAILED"])],
  ["STARTING", new Set(["RUNNING", "FAILED"])],
  ["RUNNING", new Set(["PULLING_MODEL", "PROBING", "FAILED", "DEGRADED"])],
  ["PULLING_MODEL", new Set(["PROBING", "FAILED", "DEGRADED"])],
  ["PROBING", new Set(["READY", "FAILED", "DEGRADED"])],
  ["READY", new Set(["STARTING", "PULLING_MODEL", "PROBING", "DEGRADED", "FAILED"])],
  ["DEGRADED", new Set(["STARTING", "PULLING_MODEL", "PROBING", "FAILED", "READY"])],
  ["FAILED", new Set(["INSTALLING", "INSTALLED", "STARTING", "PULLING_MODEL", "PROBING"])],
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function currentBootstrapState(state) {
  if (state === "NOT_INSTALLED" || state === "FAILED") return "INSTALLED";
  return state;
}

class LocalLlmOrchestrator extends EventEmitter {
  constructor(opts) {
    super();
    this.userDataDir = opts.userDataDir;
    this.runtimePlugin = opts.runtimePlugin || localRuntimePlugin;
    this.baseURL = opts.baseURL || this.runtimePlugin.defaultBaseURL;
    this.preferenceStore = opts.preferenceStore;
    this.statePath = path.join(this.userDataDir, "llm-runtime-state.json");
    this.leases = new Map();
    this.inFlight = null;
    this.state = this.#loadState();
  }

  getStatus() {
    return clone({
      ...this.state,
      runtime: {
        ...this.state.runtime,
        leaseCount: this.leases.size,
      },
    });
  }

  subscribe(listener) {
    this.on("status", listener);
    listener(this.getStatus());
    return () => this.off("status", listener);
  }

  async ensureReady(opts = {}) {
    const requestedModel = typeof opts.forcedModel === "string" && opts.forcedModel.trim() ? opts.forcedModel.trim() : null;
    const inFlightKey = JSON.stringify({ kind: "ensureReady", requestedModel });
    if (this.inFlight) {
      if (this.inFlight.key === inFlightKey) return this.inFlight.promise;
      throw new LocalLlmError("LOCAL_RUNTIME_BUSY", "A different local model lifecycle operation is already in progress.", {
        stage: this.state.state,
        detail: this.state.operation,
      });
    }

    const promise = this.#ensureReadyInternal({ ...opts, forcedModel: requestedModel }).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = { key: inFlightKey, promise };
    return promise;
  }

  async acquireLease(opts = {}) {
    const ready = await this.ensureReady(opts);
    const leaseId = crypto.randomUUID();
    const snapshot = {
      provider: "ollama",
      model: ready.model,
      baseURL: ready.baseURL,
      leaseId,
      revision: ready.revision,
      readiness: "READY",
    };
    this.leases.set(leaseId, {
      leaseId,
      reason: opts.reason || "unknown",
      acquiredAt: new Date().toISOString(),
      snapshot,
    });
    this.#emit();
    return snapshot;
  }

  async releaseLease(leaseId) {
    if (!leaseId) return;
    this.leases.delete(leaseId);
    this.#emit();
  }

  async #ensureReadyInternal(opts) {
    try {
      const now = Date.now();
      if (
        this.state.state === "READY" &&
        this.state.runtime.activeModel &&
        this.state.runtime.baseURL &&
        this.state.runtime.lastReadyAt &&
        now - Date.parse(this.state.runtime.lastReadyAt) < READY_TTL_MS
      ) {
        return {
          model: this.state.runtime.activeModel,
          baseURL: this.state.runtime.baseURL,
          revision: this.state.runtime.revision,
        };
      }

      const capabilities = probeHostCapabilities({ probePath: this.userDataDir });
      this.#patchRuntime({ capabilities });

      const preferredModel =
        opts.forcedModel ||
        this.preferenceStore?.getLocalPreferredModel?.() ||
        this.state.runtime.activeModel ||
        null;
      const candidates = resolveCandidateProfiles(capabilities, {
        forcedModel: preferredModel,
        useCase: opts.useCase || "general",
      });
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new LocalLlmError("MODEL_SELECTION_FAILED", "No compatible local model candidates were resolved.", {
          stage: "SELECTING_MODEL",
        });
      }

      let installation = await runtimeDriver.detectInstallation({
        persistedBinaryPath: this.state.runtime.binaryPath,
        baseURL: this.baseURL,
      });

      if (!installation.installed) {
        this.#transition("INSTALLING", { kind: "install", message: "Installing Ollama runtime…" });
        installation = await runtimeDriver.installOllama({
          userDataDir: this.userDataDir,
          onProgress: (progress) => this.#setOperation("install", progress.message || "Installing Ollama runtime…", progress),
        });
        this.#transition("INSTALLED", null, { binaryPath: installation.binaryPath });
      } else {
        this.#transition(currentBootstrapState(this.state.state), null, {
          binaryPath: installation.binaryPath,
          version: installation.version,
        });
      }

      if (!installation.running) {
        this.#transition("STARTING", { kind: "start", message: "Starting Ollama runtime…" });
        const started = await runtimeDriver.startServer({
          binaryPath: installation.binaryPath,
          baseURL: this.baseURL,
          onProgress: (progress) => this.#setOperation("start", progress.message || "Starting Ollama runtime…", progress),
        });
        this.#transition("RUNNING", null, { serverPid: started.pid, baseURL: started.baseURL });
      } else {
        this.#transition("STARTING", { kind: "start", message: "Connecting to existing Ollama runtime…" });
        this.#transition("RUNNING", null, {
          binaryPath: installation.binaryPath,
          version: installation.version,
          baseURL: this.baseURL,
        });
      }

      const installedModels = await runtimeDriver.listModels({ baseURL: this.baseURL });
      let resolvedModel = null;
      let lastError = null;

      for (const candidate of candidates) {
        try {
          const model = candidate.model;
          if (!installedModels.includes(model)) {
            this.#transition("PULLING_MODEL", { kind: "pull", message: `Downloading model ${model}…`, model });
            await runtimeDriver.pullModel({
              binaryPath: installation.binaryPath,
              model,
              onProgress: (progress) =>
                this.#setOperation("pull", progress.message || `Downloading model ${model}…`, { ...progress, model }),
            });
          }

          this.#transition("PROBING", { kind: "probe", message: `Warming model ${model}…`, model });
          await runtimeDriver.probeReadiness({ baseURL: this.baseURL, model });
          resolvedModel = model;
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!resolvedModel) {
        throw asLocalLlmError(lastError, {
          code: "PROBE_FAILED",
          stage: "PROBING",
          message: "No Ollama model candidate could be prepared successfully.",
        });
      }

      const revision = crypto.randomUUID();
      this.#transition("READY", null, {
        activeModel: resolvedModel,
        baseURL: this.baseURL,
        revision,
        lastReadyAt: new Date().toISOString(),
        lastError: null,
      });

      if (opts.activateOnSuccess && this.preferenceStore?.activateLocalProvider) {
        await this.preferenceStore.activateLocalProvider({ model: resolvedModel });
      } else if (this.preferenceStore?.setLocalPreferredModel) {
        await this.preferenceStore.setLocalPreferredModel(resolvedModel);
      }

      return {
        model: resolvedModel,
        baseURL: this.baseURL,
        revision,
      };
    } catch (err) {
      throw this.#fail(err);
    }
  }

  markDegraded(err) {
    const localErr = asLocalLlmError(err, {
      code: "LOCAL_RUNTIME_DEGRADED",
      stage: "DEGRADED",
      message: "Local runtime became unavailable.",
    });
    this.#transition("DEGRADED", null, {
      lastError: {
        code: localErr.code,
        message: localErr.message,
        detail: localErr.detail,
      },
    });
  }

  #loadState() {
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          state: parsed.state || "NOT_INSTALLED",
          operation: null,
          runtime: {
            binaryPath: parsed.runtime?.binaryPath || null,
            version: parsed.runtime?.version || null,
            baseURL: parsed.runtime?.baseURL || this.baseURL,
            serverPid: null,
            activeModel: parsed.runtime?.activeModel || null,
            revision: parsed.runtime?.revision || null,
            lastReadyAt: parsed.runtime?.lastReadyAt || null,
            capabilities: parsed.runtime?.capabilities || null,
            lastError: parsed.runtime?.lastError || null,
          },
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
      }
    } catch {
      // ignore
    }
    return {
      state: "NOT_INSTALLED",
      operation: null,
      runtime: {
        binaryPath: null,
        version: null,
        baseURL: this.baseURL,
        serverPid: null,
        activeModel: null,
        revision: null,
        lastReadyAt: null,
        capabilities: null,
        lastError: null,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  #persist() {
    const persisted = {
      state: this.state.state,
      runtime: {
        binaryPath: this.state.runtime.binaryPath,
        version: this.state.runtime.version,
        baseURL: this.state.runtime.baseURL,
        activeModel: this.state.runtime.activeModel,
        revision: this.state.runtime.revision,
        lastReadyAt: this.state.runtime.lastReadyAt,
        capabilities: this.state.runtime.capabilities,
        lastError: this.state.runtime.lastError,
      },
      updatedAt: this.state.updatedAt,
    };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  }

  #emit() {
    this.state.updatedAt = new Date().toISOString();
    this.#persist();
    this.emit("status", this.getStatus());
  }

  #patchRuntime(patch) {
    this.state.runtime = { ...this.state.runtime, ...patch };
    this.#emit();
  }

  #setOperation(kind, message, extra = {}) {
    this.state.operation = {
      id: this.state.operation?.id || crypto.randomUUID(),
      kind,
      message,
      ...extra,
      startedAt: this.state.operation?.startedAt || new Date().toISOString(),
    };
    this.#emit();
  }

  #transition(nextState, operation = null, runtimePatch = null) {
    const current = this.state.state;
    if (current !== nextState) {
      const allowed = VALID_TRANSITIONS.get(current);
      if (allowed && !allowed.has(nextState)) {
        throw new LocalLlmError("INVALID_STATE_TRANSITION", `Invalid local LLM transition: ${current} -> ${nextState}`, {
          stage: current,
          recoverable: false,
          detail: { current, nextState },
        });
      }
      this.state.state = nextState;
    }
    if (runtimePatch) this.state.runtime = { ...this.state.runtime, ...runtimePatch };
    this.state.operation =
      operation && operation.kind
        ? {
            id: crypto.randomUUID(),
            startedAt: new Date().toISOString(),
            ...operation,
          }
        : operation;
    this.#emit();
  }

  #fail(err) {
    const localErr = asLocalLlmError(err, {
      code: "LOCAL_RUNTIME_FAILED",
      stage: this.state.state,
      message: "Local runtime orchestration failed.",
    });
    this.state.runtime = {
      ...this.state.runtime,
      lastError: {
        code: localErr.code,
        message: localErr.message,
        detail: localErr.detail,
      },
    };
    this.#transition("FAILED", null);
    return localErr;
  }
}

module.exports = {
  LocalLlmOrchestrator,
};
