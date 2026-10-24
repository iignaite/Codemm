// Windows' own tools, by absolute path, and what Codemm runs as administrator or restarts with them. Every command is
// an argument array, never a shell.
import type { DesktopDeps } from './dockerDesktop';

/**
 * Windows PowerShell by its full path, never by name: a powershell.exe earlier on PATH could answer for it.
 * Shared by the signature checks and installers that run it.
 */
export const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const REG = 'C:\\Windows\\System32\\reg.exe';
/** A restart that lets other apps ask to save first: with no wait, /f isn't implied. */
const SHUTDOWN = 'C:\\Windows\\System32\\shutdown.exe';

/** Windows installer exit codes that mean "restart to finish". */
export const RESTART = new Set([3010, 1641]);

/**
 * A program as administrator, in its own window: Windows asks the learner first. The program and its arguments
 * arrive as $env:CODEMM_FILE and $env:CODEMM_ARGS, and its own exit code comes back. A learner who says no ends it
 * with DECLINED. .NET's Process.Start keeps Windows' error as the inner exception, which Start-Process drops, and the
 * wait is for the program alone, not every process it leaves running.
 */
export const ELEVATED =
  '$i = New-Object Diagnostics.ProcessStartInfo $env:CODEMM_FILE, "$env:CODEMM_ARGS"; $i.Verb = \'runas\'; $i.UseShellExecute = $true; ' +
  'try { $p = [Diagnostics.Process]::Start($i) } catch { $e = $_.Exception; while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 1223 }; $e = $e.InnerException }; exit 1 }; ' +
  'if (-not $p) { exit 1 }; $p.WaitForExit(); exit $p.ExitCode';
/** ERROR_CANCELLED: the learner said no to Windows' permission prompt. */
export const DECLINED = 1223;

/** Restarts Windows, on the learner's click only, when WSL or Docker's installer needs it. Run, not launched: no console flashes. */
export async function restartWindows(d: Pick<DesktopDeps, 'platform' | 'run'>) {
  if (d.platform !== 'win32') return;
  if ((await d.run(SHUTDOWN, ['/r', '/t', '0'])).code !== 0) throw new Error("Windows didn't restart. Restart it from the Start menu, then open Codemm again.");
}
