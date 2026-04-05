const path = require("path");

function registerWorkspaceIpc(deps) {
  const {
    tryRegisterIpcHandler,
    storage,
    getCurrentWorkspace,
    setCurrentWorkspace,
    resolveWorkspace,
    resolveWorkspaceDataDir,
    dialog,
  } = deps;

  tryRegisterIpcHandler("codemm:workspace:get", () => {
    const currentWorkspace = getCurrentWorkspace();
    if (!currentWorkspace) return null;
    return { workspaceDir: currentWorkspace.workspaceDir, workspaceDataDir: currentWorkspace.workspaceDataDir };
  });

  tryRegisterIpcHandler("codemm:workspace:choose", async () => {
    const r = await resolveWorkspace({ userDataDir: storage.userDataDir });
    if (!r.workspaceDir) return { ok: false, error: "Workspace selection canceled." };
    const nextWorkspaceDir = r.workspaceDir;
    const nextWorkspaceDataDir = resolveWorkspaceDataDir({
      userDataDir: storage.userDataDir,
      workspaceDir: nextWorkspaceDir,
    });
    const nextBackendDbPath = path.join(nextWorkspaceDataDir, "codemm.db");
    setCurrentWorkspace({
      workspaceDir: nextWorkspaceDir,
      workspaceDataDir: nextWorkspaceDataDir,
      backendDbPath: nextBackendDbPath,
      userDataDir: storage.userDataDir,
    });
    dialog
      .showMessageBox({
        type: "info",
        message: "Workspace changed",
        detail: "Restart Codemm-Desktop to apply the new workspace.",
      })
      .catch(() => {});
    return { ok: true, workspaceDir: nextWorkspaceDir, workspaceDataDir: nextWorkspaceDataDir };
  });
}

module.exports = { registerWorkspaceIpc };
