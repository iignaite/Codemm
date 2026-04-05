"use client";

import { useEffect, useMemo, useState } from "react";
import { useThemeMode } from "@/lib/useThemeMode";

type RemoteProvider = "openai" | "anthropic" | "gemini";

type LlmSettingsResponse = {
  configured: boolean;
  provider: string | null;
  model?: string | null;
  baseURL?: string | null;
  routingProfile?: "auto" | "fast_local" | "balanced_local" | "strong_local" | "custom";
  roleModels?: Record<string, string> | null;
  updatedAt: string | null;
};

type RouteRole = "dialogue" | "skeleton" | "tests" | "reference" | "repair" | "edit";

type RoutePlan = {
  provider: string;
  baseURL?: string | null;
  revision?: string | null;
  defaultModel?: string | null;
  routingProfile?: string | null;
  modelsByRole?: Partial<Record<RouteRole, { model?: string | null; capability?: string | null }>>;
};

type LocalLlmOperation = {
  id: string;
  kind: string;
  message: string;
  model?: string | null;
  startedAt: string;
  downloaded?: number;
  total?: number;
};

type LocalLlmStatus = {
  state: string;
  operation: LocalLlmOperation | null;
  runtime: {
    binaryPath: string | null;
    version: string | null;
    baseURL: string | null;
    activeModel: string | null;
    revision: string | null;
    lastReadyAt: string | null;
    leaseCount: number;
    lastError: { code: string; message: string; detail?: unknown } | null;
  };
  updatedAt: string;
};

type LlmControlStatus = {
  activeProvider: string | null;
  configured: boolean;
  local: LocalLlmStatus | null;
};

type CodemmBridge = {
  secrets?: {
    getLlmSettings?: () => Promise<LlmSettingsResponse>;
    setLlmSettings?: (args: {
      provider: string;
      apiKey?: string;
      model?: string | null;
      baseURL?: string | null;
      routingProfile?: "auto" | "fast_local" | "balanced_local" | "strong_local" | "custom";
      roleModels?: Record<string, string>;
    }) => Promise<unknown>;
    clearLlmSettings?: () => Promise<unknown>;
  };
  llm?: {
    getStatus?: () => Promise<LlmControlStatus>;
    getRoutePlan?: () => Promise<RoutePlan | null>;
    ensureReady?: (args: { activateOnSuccess?: boolean; useCase?: "general" | "dialogue" | "generation" | "edit" }) => Promise<{ ok?: boolean; error?: { message?: string } }>;
    subscribeStatus?: (args: { onEvent: (status: LocalLlmStatus) => void }) => Promise<{ unsubscribe?: () => Promise<void> }>;
  };
};

function getBridge(): CodemmBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { codemm?: CodemmBridge }).codemm ?? null;
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

function formatBytes(value?: number) {
  if (!value || value <= 0) return null;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

function localStateLabel(state: string | null | undefined) {
  switch (state) {
    case "NOT_INSTALLED":
      return "Not installed";
    case "INSTALLING":
      return "Installing runtime";
    case "INSTALLED":
      return "Installed";
    case "STARTING":
      return "Starting runtime";
    case "RUNNING":
      return "Runtime running";
    case "PULLING_MODEL":
      return "Downloading model";
    case "PROBING":
      return "Warming model";
    case "READY":
      return "Ready";
    case "DEGRADED":
      return "Needs recovery";
    case "FAILED":
      return "Failed";
    default:
      return "Unknown";
  }
}

function localSummary(state: string | null | undefined, model: string | null | undefined) {
  switch (state) {
    case "READY":
      return model ? `Codemm is ready to use ${model}.` : "Codemm is ready to use your local model.";
    case "INSTALLING":
      return "Installing the local runtime.";
    case "STARTING":
      return "Starting the local runtime.";
    case "PULLING_MODEL":
      return model ? `Downloading ${model}.` : "Downloading the selected model.";
    case "PROBING":
      return model ? `Warming ${model} for first use.` : "Warming the local model.";
    case "FAILED":
      return "Local setup needs attention before it can be used.";
    case "DEGRADED":
      return "The local runtime needs to recover before it can be used.";
    default:
      return "Set up a local model for Codemm.";
  }
}

export default function LlmSettingsPage() {
  const { darkMode } = useThemeMode();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activatingLocal, setActivatingLocal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LlmSettingsResponse | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmControlStatus | null>(null);
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);

  const [provider, setProvider] = useState<RemoteProvider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [routingProfile, setRoutingProfile] = useState<"auto" | "fast_local" | "balanced_local" | "strong_local" | "custom">("auto");
  const [roleModels, setRoleModels] = useState<Record<RouteRole, string>>({
    dialogue: "",
    skeleton: "",
    tests: "",
    reference: "",
    repair: "",
    edit: "",
  });

  useEffect(() => {
    let active = true;
    let unsubscribe: null | (() => Promise<void>) = null;

    async function load() {
      try {
        const bridge = getBridge();
        const secretsApi = bridge?.secrets;
        const llmApi = bridge?.llm;
        if (!secretsApi?.getLlmSettings || !llmApi?.getStatus || !llmApi?.subscribeStatus || !llmApi?.getRoutePlan) {
          setError("IDE bridge unavailable. Launch this screen inside Codemm-Desktop.");
          return;
        }

        const [settings, control, nextRoutePlan] = await Promise.all([
          secretsApi.getLlmSettings() as Promise<LlmSettingsResponse>,
          llmApi.getStatus() as Promise<LlmControlStatus>,
          llmApi.getRoutePlan() as Promise<RoutePlan | null>,
        ]);
        if (!active) return;

        setStatus(settings);
        setLlmStatus(control);
        setRoutePlan(nextRoutePlan);
        setRoutingProfile(settings.routingProfile ?? "auto");
        setRoleModels((prev) => ({
          ...prev,
          dialogue: settings.roleModels?.dialogue ?? "",
          skeleton: settings.roleModels?.skeleton ?? "",
          tests: settings.roleModels?.tests ?? "",
          reference: settings.roleModels?.reference ?? "",
          repair: settings.roleModels?.repair ?? "",
          edit: settings.roleModels?.edit ?? "",
        }));

        const currentProvider = String(settings.provider || "").toLowerCase();
        if (currentProvider === "openai" || currentProvider === "anthropic" || currentProvider === "gemini") {
          setProvider(currentProvider);
        }

        const sub = await llmApi.subscribeStatus({
          onEvent: (nextStatus: LocalLlmStatus) => {
            if (!active) return;
            setLlmStatus((prev) => ({
              activeProvider: prev?.activeProvider ?? settings.provider ?? null,
              configured: prev?.configured ?? settings.configured,
              local: nextStatus,
            }));
          },
        });

        if (active && sub?.unsubscribe) {
          unsubscribe = sub.unsubscribe;
        }
      } catch (err: unknown) {
        if (active) setError(errorMessage(err, "Failed to load LLM settings"));
      } finally {
        if (active) setLoading(false);
      }
    }

    load();

    return () => {
      active = false;
      if (unsubscribe) {
        unsubscribe().catch(() => {});
      }
    };
  }, []);

  async function refreshStatus() {
    const bridge = getBridge();
    const secretsApi = bridge?.secrets;
    const llmApi = bridge?.llm;
    if (!secretsApi?.getLlmSettings || !llmApi?.getStatus || !llmApi?.getRoutePlan) return;

    const [settings, control, nextRoutePlan] = await Promise.all([
      secretsApi.getLlmSettings() as Promise<LlmSettingsResponse>,
      llmApi.getStatus() as Promise<LlmControlStatus>,
      llmApi.getRoutePlan() as Promise<RoutePlan | null>,
    ]);
    setStatus(settings);
    setLlmStatus(control);
    setRoutePlan(nextRoutePlan);
  }

  async function saveRemoteProvider() {
    const api = getBridge()?.secrets;
    if (!api?.setLlmSettings) {
      setError("IDE bridge unavailable. Launch this screen inside Codemm-Desktop.");
      return;
    }

    setError(null);
    setSaving(true);
    try {
      await api.setLlmSettings({
        provider,
        apiKey,
        routingProfile,
        roleModels: routingProfile === "custom" ? roleModels : undefined,
      });
      setApiKey("");
      await refreshStatus();
    } catch (err: unknown) {
      setError(errorMessage(err, "Failed to save provider settings"));
    } finally {
      setSaving(false);
    }
  }

  async function clearProvider() {
    const api = getBridge()?.secrets;
    if (!api?.clearLlmSettings) {
      setError("IDE bridge unavailable. Launch this screen inside Codemm-Desktop.");
      return;
    }

    setError(null);
    setSaving(true);
    try {
      await api.clearLlmSettings();
      setApiKey("");
      await refreshStatus();
    } catch (err: unknown) {
      setError(errorMessage(err, "Failed to clear provider settings"));
    } finally {
      setSaving(false);
    }
  }

  async function activateLocalModel() {
    const api = getBridge()?.llm;
    if (!api?.ensureReady) {
      setError("IDE bridge unavailable. Launch this screen inside Codemm-Desktop.");
      return;
    }

    setError(null);
    setActivatingLocal(true);
    try {
      const res = await api.ensureReady({ activateOnSuccess: true, useCase: "general" });
      if (res?.ok === false) {
        throw new Error(res?.error?.message || "Local model activation failed.");
      }
      await refreshStatus();
    } catch (err: unknown) {
      setError(errorMessage(err, "Failed to activate local model"));
      await refreshStatus().catch(() => {});
    } finally {
      setActivatingLocal(false);
    }
  }

  const local = llmStatus?.local ?? null;
  const isLocalActive = status?.provider === "ollama" && local?.state === "READY";
  const activeModel = local?.runtime.activeModel || status?.model || null;
  const weakestRoute = routePlan?.modelsByRole
    ? Object.values(routePlan.modelsByRole).find((route) => route?.capability === "weak")
    : null;
  const localOperationMeta = useMemo(() => {
    if (!local?.operation) return null;
    const downloaded = formatBytes(local.operation.downloaded);
    const total = formatBytes(local.operation.total);
    if (downloaded && total) return `${downloaded} / ${total}`;
    if (downloaded) return downloaded;
    return null;
  }, [local]);
  const localPrimaryCopy = activatingLocal
    ? local?.operation?.message || "Preparing your local model…"
    : isLocalActive
      ? activeModel
        ? `Codemm is now using ${activeModel}.`
        : "Codemm is now using your local Ollama model."
      : localSummary(local?.state, activeModel);

  return (
    <div className={`min-h-screen transition-colors ${darkMode ? "bg-slate-900 text-slate-100" : "bg-white text-slate-900"}`}>
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">LLM Settings</h1>
            <p className={`mt-2 text-sm ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
              Choose a cloud API key or let Codemm run a local Ollama model on this machine.
            </p>
          </div>
          <button
            className={`rounded-lg px-3 py-2 text-sm font-medium ${
              darkMode ? "bg-slate-800 hover:bg-slate-700" : "bg-slate-100 hover:bg-slate-200"
            }`}
            onClick={() => history.back()}
          >
            Back
          </button>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <section className={`rounded-2xl border p-5 ${darkMode ? "border-slate-800 bg-slate-950" : "border-slate-200 bg-white"}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Local Model</h2>
                <p className={`mt-2 text-sm ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
                  Codemm can install and use Ollama automatically.
                </p>
              </div>
              <div
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  isLocalActive
                    ? darkMode
                      ? "bg-emerald-950 text-emerald-200"
                      : "bg-emerald-50 text-emerald-700"
                    : darkMode
                      ? "bg-slate-800 text-slate-300"
                      : "bg-slate-100 text-slate-600"
                }`}
              >
                {isLocalActive ? "Using local model" : "Not using local model"}
              </div>
            </div>

            {error ? (
              <div className={`mt-4 rounded-lg px-3 py-2 text-sm ${darkMode ? "bg-rose-950 text-rose-200" : "bg-rose-50 text-rose-700"}`}>
                {error}
              </div>
            ) : null}

            <div className={`mt-5 rounded-xl border p-5 ${darkMode ? "border-slate-800 bg-slate-900/60" : "border-slate-200 bg-slate-50"}`}>
              <div className="text-xl font-semibold">{localPrimaryCopy}</div>
              <p className={`mt-2 text-sm ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
                {isLocalActive
                  ? "New chat, generation, hint, and edit requests will use the local model."
                  : activatingLocal
                    ? "This may take a few minutes the first time."
                    : "Click once to set up Ollama and switch Codemm to local inference."}
              </p>

              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">Status</div>
                  <div className={`mt-1 text-sm ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
                    {localStateLabel(local?.state)}
                  </div>
                </div>
                <button
                  className={`rounded-lg px-4 py-2 text-sm font-semibold ${
                    isLocalActive
                      ? darkMode
                        ? "bg-slate-800 text-slate-300"
                        : "bg-slate-100 text-slate-600"
                      : darkMode
                        ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                        : "bg-emerald-600 hover:bg-emerald-500 text-white"
                  } ${activatingLocal || loading ? "opacity-60" : ""}`}
                  onClick={activateLocalModel}
                  disabled={loading || activatingLocal || isLocalActive}
                >
                  {activatingLocal ? "Preparing local model…" : isLocalActive ? "Local model in use" : "Use Local Model"}
                </button>
              </div>

              <div className="mt-4 grid gap-3">
                <div>
                  <label className={`block text-sm font-medium ${darkMode ? "text-slate-200" : "text-slate-700"}`}>Routing profile</label>
                  <select
                    className={`mt-2 w-full rounded-lg border px-3 py-2 text-sm ${
                      darkMode ? "border-slate-700 bg-slate-900 text-slate-100" : "border-slate-300 bg-white text-slate-900"
                    }`}
                    value={routingProfile}
                    onChange={(e) => setRoutingProfile(e.target.value as "auto" | "fast_local" | "balanced_local" | "strong_local" | "custom")}
                    disabled={saving || activatingLocal}
                  >
                    <option value="auto">Auto (recommended)</option>
                    <option value="fast_local">Fast local</option>
                    <option value="balanced_local">Balanced local</option>
                    <option value="strong_local">Strong local</option>
                    <option value="custom">Custom per-role</option>
                  </select>
                </div>

                {routingProfile === "custom" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(["dialogue", "skeleton", "tests", "reference", "repair", "edit"] as RouteRole[]).map((role) => (
                      <div key={role}>
                        <label className={`block text-xs font-medium uppercase tracking-wide ${darkMode ? "text-slate-300" : "text-slate-600"}`}>{role}</label>
                        <input
                          className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                            darkMode ? "border-slate-700 bg-slate-900 text-slate-100" : "border-slate-300 bg-white text-slate-900"
                          }`}
                          value={roleModels[role]}
                          onChange={(e) => setRoleModels((prev) => ({ ...prev, [role]: e.target.value }))}
                          placeholder={activeModel || "model name"}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="mt-4 grid gap-2 text-sm">
                <div>Current model: {activeModel || "Choosing a model..."}</div>
                <div>{isLocalActive ? "Inference is currently routed to your local model." : "Codemm will switch to the local model when setup finishes."}</div>
              </div>

              {status?.provider === "ollama" && weakestRoute ? (
                <div className={`mt-4 rounded-lg px-3 py-3 text-sm ${darkMode ? "bg-amber-950 text-amber-200" : "bg-amber-50 text-amber-800"}`}>
                  Weak local routes can block hard or multi-topic generation. Switch to a stronger profile if runs fail early.
                </div>
              ) : null}

              {local?.operation ? (
                <div className={`mt-4 rounded-lg px-3 py-3 text-sm ${darkMode ? "bg-slate-950 text-slate-200" : "bg-white text-slate-700"}`}>
                  <div className="font-medium">{local.operation.message}</div>
                  <div className={`mt-1 text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
                    {local.operation.model ? `${local.operation.model}` : local.operation.kind}
                    {localOperationMeta ? ` • ${localOperationMeta}` : ""}
                  </div>
                </div>
              ) : null}

              {local?.runtime.lastError ? (
                <div className={`mt-4 rounded-lg px-3 py-3 text-sm ${darkMode ? "bg-rose-950 text-rose-200" : "bg-rose-50 text-rose-700"}`}>
                  <div className="font-medium">Local setup needs attention</div>
                  <div className="mt-1">{local.runtime.lastError.message}</div>
                </div>
              ) : null}

              <details className={`mt-4 rounded-lg border px-3 py-3 text-sm ${darkMode ? "border-slate-800 bg-slate-950 text-slate-300" : "border-slate-200 bg-white text-slate-600"}`}>
                <summary className="cursor-pointer font-medium">Technical details</summary>
                <div className="mt-3 grid gap-2 text-sm">
                  <div>Runtime URL: {local?.runtime.baseURL || "Unavailable"}</div>
                  <div>Version: {local?.runtime.version || "Unknown"}</div>
                  <div>Leases: {typeof local?.runtime.leaseCount === "number" ? local.runtime.leaseCount : 0}</div>
                  <div>Configured provider: {status?.provider || "None"}</div>
                  <div>Routing profile: {status?.routingProfile || "auto"}</div>
                  <div>Last updated: {status?.updatedAt ? new Date(status.updatedAt).toLocaleString() : "Never"}</div>
                  {local?.runtime.lastReadyAt ? <div>Last ready check: {new Date(local.runtime.lastReadyAt).toLocaleString()}</div> : null}
                  {local?.runtime.lastError ? <div>Error code: {local.runtime.lastError.code}</div> : null}
                  {routePlan?.modelsByRole ? (
                    <div>
                      Route plan: {Object.entries(routePlan.modelsByRole)
                        .map(([role, route]) => `${role}:${route?.model || "auto"}${route?.capability ? ` (${route.capability})` : ""}`)
                        .join(" | ")}
                    </div>
                  ) : null}
                </div>
              </details>
            </div>
          </section>

          <section className={`rounded-2xl border p-5 ${darkMode ? "border-slate-800 bg-slate-950" : "border-slate-200 bg-white"}`}>
            <h2 className="text-lg font-semibold">Cloud Provider</h2>
            <p className={`mt-2 text-sm ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
              Save an API key here if you want to switch away from the local model.
            </p>

            <div className="mt-5 grid gap-4">
              <div>
                <label className={`block text-sm font-medium ${darkMode ? "text-slate-200" : "text-slate-700"}`}>Provider</label>
                <select
                  className={`mt-2 w-full rounded-lg border px-3 py-2 text-sm ${
                    darkMode ? "border-slate-700 bg-slate-900 text-slate-100" : "border-slate-300 bg-white text-slate-900"
                  }`}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as RemoteProvider)}
                  disabled={saving}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                </select>
              </div>

              <div>
                <label className={`block text-sm font-medium ${darkMode ? "text-slate-200" : "text-slate-700"}`}>API Key</label>
                <input
                  className={`mt-2 w-full rounded-lg border px-3 py-2 text-sm ${
                    darkMode ? "border-slate-700 bg-slate-900 text-slate-100" : "border-slate-300 bg-white text-slate-900"
                  }`}
                  type="password"
                  placeholder={status?.configured && status.provider !== "ollama" ? "••••••••••••••••" : "paste your key here"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                className={`rounded-lg px-4 py-2 text-sm font-semibold ${
                  darkMode ? "bg-sky-600 hover:bg-sky-500 text-white" : "bg-sky-600 hover:bg-sky-500 text-white"
                } ${saving ? "opacity-60" : ""}`}
                onClick={saveRemoteProvider}
                disabled={saving || !apiKey.trim()}
              >
                {saving ? "Saving…" : "Use Cloud Provider"}
              </button>
              <button
                className={`rounded-lg px-4 py-2 text-sm font-semibold ${
                  darkMode ? "bg-slate-800 hover:bg-slate-700" : "bg-slate-100 hover:bg-slate-200"
                } ${saving ? "opacity-60" : ""}`}
                onClick={clearProvider}
                disabled={saving || !status?.configured}
              >
                Clear Provider
              </button>
            </div>
          </section>
        </div>

        <div className={`mt-6 rounded-2xl border p-5 text-sm ${darkMode ? "border-slate-800 bg-slate-950 text-slate-300" : "border-slate-200 bg-white text-slate-600"}`}>
          <div className="font-medium">
            {isLocalActive
              ? `Currently using local model${activeModel ? `: ${activeModel}` : ""}`
              : status?.provider
                ? `Currently using ${status.provider}`
                : "No provider configured"}
          </div>
          <div className="mt-1">
            {isLocalActive
              ? "Codemm is routing LLM requests to Ollama on this machine."
              : "Switch to a local model or save a cloud API key."}
          </div>
        </div>
      </div>
    </div>
  );
}
