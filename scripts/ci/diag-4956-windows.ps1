# Scratch diagnostic for #4956 Windows: loop one batch and snapshot the process tree when the
# test process goes quiet. Not for merge.
param([int]$Iterations = 15, [int]$QuietSeconds = 9)
$ErrorActionPreference = "Continue"
$files = @(
  "tests/codex-integration/codex-catalog-golden.test.ts",
  "tests/codex-integration/codex-catalog-ladders.test.ts",
  "tests/codex-integration/codex-cli-installation-identity.test.ts",
  "tests/codex-integration/codex-cli-update-zero-effect.test.ts",
  "tests/codex-integration/codex-config-preservation.test.ts",
  "tests/codex-integration/codex-history-lock.test.ts"
)
if ($env:REPRO_FILES) { $files = $env:REPRO_FILES -split " " }
New-Item -ItemType Directory -Force -Path repro-out | Out-Null
$bun = (Get-Command bun).Source
"bun: $bun $(& $bun --version)" | Tee-Object -FilePath repro-out/summary.txt
function Snapshot([int]$rootPid, [string]$tag) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine
  $tree = @($rootPid); $frontier = @($rootPid)
  while ($frontier.Count -gt 0) {
    $next = @($all | Where-Object { $frontier -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })
    $tree += $next; $frontier = $next
  }
  $out = "repro-out/stall-$tag.txt"
  "=== $tag root $rootPid at $(Get-Date -Format o)" | Out-File $out
  $all | Where-Object { $tree -contains $_.ProcessId } | ForEach-Object {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    $cpu = if ($p) { $p.CPU } else { "gone" }
    $threads = if ($p) { ($p.Threads | Group-Object ThreadState | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join "," } else { "" }
    "pid=$($_.ProcessId) ppid=$($_.ParentProcessId) name=$($_.Name) created=$($_.CreationDate) cpu=$cpu threads=$threads cmd=$(([string]$_.CommandLine).Substring(0, [Math]::Min(300, ([string]$_.CommandLine).Length)))"
  } | Out-File $out -Append
  Start-Sleep -Seconds 3
  "--- 3s later cpu" | Out-File $out -Append
  foreach ($id in $tree) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { "pid=$id cpu=$($p.CPU)" | Out-File $out -Append } }
  Write-Host "::warning::stall snapshot $out"
}
$stalls = 0; $slow = 0
for ($i = 1; $i -le $Iterations; $i++) {
  $log = "repro-out/run-$i.log"
  $start = Get-Date
  $proc = Start-Process -FilePath $bun -ArgumentList (@("test", "--isolate", "--timeout", "60000") + $files) -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -NoNewWindow
  $lastSize = -1; $lastChange = Get-Date; $snapped = 0
  while (-not $proc.HasExited) {
    Start-Sleep -Milliseconds 1000
    $size = (Get-Item $log -ErrorAction SilentlyContinue).Length + (Get-Item "$log.err" -ErrorAction SilentlyContinue).Length
    if ($size -ne $lastSize) { $lastSize = $size; $lastChange = Get-Date }
    elseif (((Get-Date) - $lastChange).TotalSeconds -ge $QuietSeconds -and $snapped -lt 2) {
      $snapped++; Snapshot $proc.Id "$i-$snapped"; $lastChange = Get-Date
    }
    if (((Get-Date) - $start).TotalSeconds -gt 150) { Stop-Process -Id $proc.Id -Force; break }
  }
  $proc.WaitForExit()
  $secs = [int]((Get-Date) - $start).TotalSeconds
  $text = (Get-Content $log, "$log.err" -Raw -ErrorAction SilentlyContinue) -join ""
  $failed = ([regex]::Matches($text, "\(fail\)")).Count
  $zt = [regex]::Match($text, "published Node launcher attest[^\[]*\[([0-9.]+)ms\]").Groups[1].Value
  if ($snapped) { $stalls++ }
  if ($failed) { $slow++ }
  "iteration $i exit=$($proc.ExitCode) seconds=$secs fails=$failed zeroEffectMs=$zt quietSnapshots=$snapped" | Tee-Object -FilePath repro-out/summary.txt -Append
  if (-not $snapped -and -not $failed) { Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue }
}
"quietBatches=$stalls failingBatches=$slow of $Iterations" | Tee-Object -FilePath repro-out/summary.txt -Append

