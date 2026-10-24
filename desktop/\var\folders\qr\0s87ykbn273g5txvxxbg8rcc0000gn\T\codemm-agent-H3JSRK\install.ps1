$downloadUrl = 'https://downloads.cursor.com/lab/2026.10.22-27dcf5f/'
$version = '2026.10.22-27dcf5f'
Write-Host 'Git for Windows (with Git Bash) is required to run a private worker.'
Write-Host 'Install it from https://git-scm.com/download/win'
function Get-Architecture {
    # PROCESSOR_ARCHITEW6432 is set for 32-bit PowerShell on 64-bit Windows.
    # x64 PowerShell on ARM64 reports AMD64 and leaves that variable empty,
    # so the machine SystemType is what distinguishes it.
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ($arch -eq "ARM64") { return "arm64" }
    try {
        $systemType = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).SystemType
    } catch {
        $systemType = (Get-WmiObject Win32_ComputerSystem).SystemType
    }
    if ($systemType -like "*ARM64*") { return "arm64" }
    return "x64"
}
function Get-TarPath {
    # A 32-bit PowerShell is redirected from System32 to SysWOW64, which has
    # no tar.exe. Sysnative is the real System32 from that process.
    if ($env:PROCESSOR_ARCHITEW6432) {
        return "$env:SystemRoot\Sysnative\tar.exe"
    }
    return "$env:SystemRoot\System32\tar.exe"
}
function Test-VersionInUse {
    param([string]$VersionsDir)
    if (-not (Test-Path -LiteralPath $VersionsDir)) { return $false }
    foreach ($dir in Get-ChildItem -LiteralPath $VersionsDir -Directory -ErrorAction SilentlyContinue) {
        $running = Join-Path $dir.FullName ".running"
        if (-not (Test-Path -LiteralPath $running)) { continue }
        foreach ($marker in Get-ChildItem -LiteralPath $running -File -ErrorAction SilentlyContinue) {
            $procId = 0
            if (-not [int]::TryParse($marker.Name, [ref]$procId)) { continue }
            try {
                $null = Get-Process -Id $procId -ErrorAction Stop
                return $true
            } catch {
                # NoProcessFoundForGivenId means the pid is gone. Any other
                # failure is not proof, so leave the live launcher alone.
                if ($_.FullyQualifiedErrorId -like "NoProcessFoundForGivenId*") { continue }
                return $true
            }
        }
    }
    return $false
}
function Install-StagedPromoteHook {
    param([string]$VersionsDir)
    $cmdPath = Join-Path $VersionsDir "promote-staged.cmd"
    @'
@echo off
setlocal EnableExtensions
rem One promote at a time. A second waiter must not rename the tree this one just promoted.
rem A lock older than 30 minutes is a killed promote, not a live waiter.
set "PROMOTELOCK=%~dp0.promote-lock"
mkdir "%PROMOTELOCK%" 2>nul
if not errorlevel 1 goto :promotebody
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "if ((Get-Item -LiteralPath $env:PROMOTELOCK).LastWriteTime -lt (Get-Date).AddMinutes(-30)) { exit 2 } else { exit 0 }"
if not errorlevel 2 goto :promoteheld
if errorlevel 3 goto :promoteheld
rmdir "%PROMOTELOCK%"
mkdir "%PROMOTELOCK%" 2>nul
if errorlevel 1 goto :promoteheld
goto :promotebody
:promoteheld
exit /b 0
:promotebody
rem A launcher waiting out a live agent lives under versions, not on PATH.
for %%F in ("%~dp0pending-launchers\*.pending") do if exist "%%~fF" (
  move /y "%%~fF" "%~dp0..\%%~nF" >nul 2>&1
)
rem A locked .previous tree stays until a later update can remove it.
for /d %%D in ("%~dp0*.new") do if exist "%%~fD\" (
  if exist "%%~dpD%%~nD" (
    if exist "%%~dpD%%~nD.previous" (
      rmdir /s /q "%%~dpD%%~nD.previous"
    )
    if exist "%%~dpD%%~nD.previous" (
      echo Could not remove "%%~dpD%%~nD.previous"; leaving the staged update until it is free 1>&2
    ) else (
      ren "%%~dpD%%~nD" "%%~nD.previous"
      if errorlevel 1 (
        echo Failed to rename "%%~dpD%%~nD" to "%%~nD.previous" 1>&2
        call :logfail Failed to rename "%%~dpD%%~nD" to "%%~nD.previous"
      )
    )
  )
  if not exist "%%~dpD%%~nD" (
    ren "%%~fD" "%%~nD"
    if errorlevel 1 (
      echo Failed to rename "%%~fD" to "%%~nD" 1>&2
      call :logfail Failed to rename "%%~fD" to "%%~nD"
      rmdir "%~dp0.promote-lock"
      exit /b 1
    )
  )
)
rmdir "%~dp0.promote-lock"
exit /b 0
rem A stuck rename must not grow this log without bound.
:logfail
if not exist "%~dp0replace.log" goto :logwrite
for %%L in ("%~dp0replace.log") do if %%~zL GEQ 65536 exit /b 0
:logwrite
>>"%~dp0replace.log" echo %*
exit /b 0
'@ | Set-Content -LiteralPath $cmdPath -Encoding ascii
    $root = Split-Path $VersionsDir
    # cmd.exe keeps a byte offset in a running .cmd. Prepending the hook
    # while that session is inside the file makes the old body run again.
    if (Test-VersionInUse -VersionsDir $VersionsDir) {
        Write-Host "A Cursor agent is still running. Leaving the live launchers unchanged."
        return
    }
    foreach ($name in @("cursor-agent.cmd", "agent.cmd", "cursor-agent.ps1", "agent.ps1")) {
        $shim = Join-Path $root $name
        if (-not (Test-Path -LiteralPath $shim)) { continue }
        $text = Get-Content -LiteralPath $shim -Raw
        if ($text -match "cursor-agent-promote-staged") { continue }
        if ($name.EndsWith(".ps1")) {
            $hook = @'
# cursor-agent-promote-staged
$promoteStaged = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "versions\promote-staged.cmd"
if (Test-Path -LiteralPath $promoteStaged) {
  & $promoteStaged
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

'@
        } else {
            $hook = @'
@echo off
rem cursor-agent-promote-staged
if exist "%~dp0versions\promote-staged.cmd" call "%~dp0versions\promote-staged.cmd"
if errorlevel 1 exit /b 1

'@
        }
        Set-Content -LiteralPath $shim -Value ($hook + $text) -Encoding ascii
    }
}
function Get-AgentHostSwitchRecord {
    $configDir = Join-Path $env:USERPROFILE ".cursor"
    if ($env:XDG_CONFIG_HOME -and $env:XDG_CONFIG_HOME.Trim()) { $configDir = Join-Path $env:XDG_CONFIG_HOME "cursor" }
    if ($env:CURSOR_CONFIG_DIR -and $env:CURSOR_CONFIG_DIR.Trim()) { $configDir = $env:CURSOR_CONFIG_DIR }
    return (Join-Path $configDir "grok-switch.json")
}
function Test-AgentHostSwitchLauncher {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    # A launcher that can't be read may be a switch launcher, so it counts as one.
    try { $text = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop } catch { return $true }
    return ($text -match "cursor-agent-host-switch")
}
function Stop-AgentHostSwitch {
    param([string]$RootDir, [bool]$LaunchersReplaced)
    $record = Get-AgentHostSwitchRecord
    if (-not (Test-Path -LiteralPath $record)) { return }
    $stillSwitched = "agent still runs Grok agent host. Close any running agents and run this installer again."
    if (-not $LaunchersReplaced) {
        Write-Host $stillSwitched
        return
    }
    # The promote hook moves a staged launcher over the live one, so a staged
    # switch launcher would put agent back on agent-host at its next start.
    $pending = Join-Path $RootDir "versions\pending-launchers"
    foreach ($file in Get-ChildItem -LiteralPath $pending -Filter "*.pending" -File -ErrorAction SilentlyContinue) {
        if (Test-AgentHostSwitchLauncher -Path $file.FullName) {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
        }
    }
    $remaining = @(Get-ChildItem -LiteralPath $pending -Filter "*.pending" -File -ErrorAction SilentlyContinue | Where-Object { Test-AgentHostSwitchLauncher -Path $_.FullName })
    $remaining += @(@("agent.cmd", "agent.ps1") | ForEach-Object { Join-Path $RootDir $_ } | Where-Object { Test-AgentHostSwitchLauncher -Path $_ })
    if ($remaining.Count -gt 0) {
        Write-Host $stillSwitched
        return
    }
    try { & (Join-Path $RootDir "cursor-agent.cmd") --version | Out-Null } catch { }
    if (Test-Path -LiteralPath $record) {
        Write-Host "The next cursor-agent start finishes ending the switch to Grok agent host."
    }
}
function Download-InstallPackage {
    param(
        [string]$UrlPrefix,
        [string]$TargetPath,
        [string]$Version
    )

    $tempFile = "$TargetPath\$([System.Guid]::NewGuid().ToString()).zip"
    $extractDir = "$TargetPath\extract-$([System.Guid]::NewGuid().ToString())"
    $architecture = Get-Architecture
    $fullUrl = $UrlPrefix + "windows/$architecture/agent-cli-package.zip"

    try {
        Invoke-WebRequest -Uri $fullUrl -OutFile $tempFile
        New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
        # tar.exe handles the package's deep tree. Expand-Archive stops at MAX_PATH.
        & (Get-TarPath) -xf $tempFile -C $extractDir
        if ($LASTEXITCODE -ne 0) { throw "tar.exe exited with code $LASTEXITCODE" }
        $finalDir = Join-Path $TargetPath $Version
        $stagedDir = "$finalDir.new"
        $previousDir = "$finalDir.previous"
        $swappedLive = $false
        $launchersReplaced = $false
        if (Test-Path $stagedDir) { Remove-Item -Recurse -Force $stagedDir }
        Move-Item -Path "$extractDir\dist-package" -Destination $stagedDir
        if (Test-Path $finalDir) {
            if (Test-Path $previousDir) {
                try { Remove-Item -Recurse -Force $previousDir } catch { }
            }
            try {
                Move-Item -Path $finalDir -Destination $previousDir
                Move-Item -Path $stagedDir -Destination $finalDir
                $swappedLive = $true
            } catch {
                if (-not (Test-Path $finalDir) -and (Test-Path $previousDir)) {
                    try { Move-Item -Path $previousDir -Destination $finalDir } catch { }
                }
                if (Test-Path $stagedDir) {
                    Install-StagedPromoteHook -VersionsDir $TargetPath
                }
                throw
            }
        } else {
            Move-Item -Path $stagedDir -Destination $finalDir
        }
        if (-not (Test-Path $finalDir)) { throw "Windows package was staged but not installed" }

        try {
            # A running cmd keeps a byte offset in the live shim. Copying first
            # replaces that file, and the promote hook then refuses to arm it.
            if (Test-VersionInUse -VersionsDir $TargetPath) {
                Install-StagedPromoteHook -VersionsDir $TargetPath
                Write-Host "A Cursor agent is still running. Leaving the live launchers unchanged."
            } else {
                # Copy all files that begin with 'cursor-agent' to the root dir
                Get-ChildItem -Path "$finalDir" -Filter 'cursor-agent*' | Copy-Item -Destination "$TargetPath\.."

                # Create agent alias (primary command) for cursor-agent
                $rootDir = "$TargetPath\.."
                if (Test-Path "$rootDir\cursor-agent.exe") {
                    Copy-Item -Path "$rootDir\cursor-agent.exe" -Destination "$rootDir\agent.exe" -Force
                }
                if (Test-Path "$rootDir\cursor-agent.cmd") {
                    Copy-Item -Path "$rootDir\cursor-agent.cmd" -Destination "$rootDir\agent.cmd" -Force
                }
                if (Test-Path "$rootDir\cursor-agent.ps1") {
                    Copy-Item -Path "$rootDir\cursor-agent.ps1" -Destination "$rootDir\agent.ps1" -Force
                }
                Install-StagedPromoteHook -VersionsDir $TargetPath
                $launchersReplaced = $true
            }
        } catch {
            # The live tree is already at .previous. Put it back so the old
            # shims still start, and leave the new tree staged.
            if ($swappedLive) {
                if (Test-Path $finalDir) {
                    if (Test-Path $stagedDir) { Remove-Item -Recurse -Force $stagedDir }
                    try { Move-Item -Path $finalDir -Destination $stagedDir } catch { }
                }
                if (-not (Test-Path $finalDir) -and (Test-Path $previousDir)) {
                    try { Move-Item -Path $previousDir -Destination $finalDir } catch { }
                }
                try { Install-StagedPromoteHook -VersionsDir $TargetPath } catch { }
            }
            throw
        }
        Stop-AgentHostSwitch -RootDir "$TargetPath\.." -LaunchersReplaced $launchersReplaced
    }
    finally {
        if (Test-Path $tempFile) {
            Remove-Item $tempFile
        }
        if (Test-Path $extractDir) {
            Remove-Item -Recurse -Force $extractDir
        }
    }
}
function Initialize-CursorAgent {
    ## initially set up the cursor-agent directory
    ## Create %LocalAppData%\cursor-agent\versions
    ## Add %LocalAppData%\cursor-agent to PATH
    $agentPath = "$env:LOCALAPPDATA\cursor-agent"
    $versionsPath = "$agentPath\versions"

    # If $agentPath exists, delete it
    if (Test-Path $agentPath) {
        Remove-Item -Recurse -Force $agentPath
    }

    New-Item -ItemType Directory -Path $agentPath -Force | Out-Null
    New-Item -ItemType Directory -Path $versionsPath -Force | Out-Null

    # Add to PATH
    $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($currentPath -notlike "*$agentPath*") {
        [Environment]::SetEnvironmentVariable("PATH", "$currentPath;$agentPath", "User")
    }

    # Add to current shell PATH
    if ($env:PATH -notlike "*$agentPath*") {
        $env:PATH = "$env:PATH;$agentPath"
    }
}
function Print-CursorAgentInstructions {
    Write-Host "Git for Windows (with Git Bash) is required to run a private worker."
    Write-Host "Install it from https://git-scm.com/download/win"
    Write-Host ""
    Write-Host "Start using Cursor Agent:"
    Write-Host "   agent"
    Write-Host ""
    Write-Host ""
    Write-Host "Happy coding!"
    Write-Host ""
}

Initialize-CursorAgent
Download-InstallPackage -UrlPrefix $downloadUrl -TargetPath "$env:LOCALAPPDATA\cursor-agent\versions" -Version $version
Print-CursorAgentInstructions