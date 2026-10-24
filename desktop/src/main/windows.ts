/**
 * Windows PowerShell by its full path, never by name: a powershell.exe earlier on PATH could answer for it.
 * Shared by the signature checks and installers that run it.
 */
export const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** taskkill by its full path, for the same reason: it stops an agent's process tree (agent/bridge.ts). */
export const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';
