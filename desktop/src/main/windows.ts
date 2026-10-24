/**
 * Windows PowerShell by its full path, never by name: a powershell.exe earlier on PATH could answer for it.
 * Shared by the signature checks and installers that run it.
 */
export const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Windows installer exit codes that mean "restart to finish". */
export const RESTART = new Set([3010, 1641]);
