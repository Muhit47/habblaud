// Windows: terminates Claude Code session in another terminal without corrupting console modes.
// Claude Code enables advanced terminal modes (mouse, focus, extended keyboard, win32-input-mode,
// bracketed paste, alt screen) and resets them on normal exit. Forcefully killed (TerminateProcess),
// modes remain active and Windows Terminal passes mouse/focus escape sequences as raw text to shell.
// Therefore a PowerShell helper attaches to session console (AttachConsole), terminates process, sends
// mode-reset escape sequences to console, and restores console input mode to normal defaults.
// Before terminating, verifies PID still belongs to same process (exact FILETIME): reused PID is never killed.
import { execFile } from 'node:child_process';
import { tr } from '../../shared/i18n';

/** Desliga o que o Claude Code liga: mouse, foco, colagem, teclado (kitty e win32-input), tela alternativa. */
export const TERMINAL_RESET =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?2031l\x1b[?9001l\x1b[<u\x1b[>4;0m\x1b[?25h\x1b[0m\r\n';

function script(pid: number, fileTime: string): string {
  const reset = [...TERMINAL_RESET].map((c) => `[char]${c.charCodeAt(0)}`).join('+');
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class HabblaudConsole {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sec, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool WriteConsoleW(IntPtr h, string s, uint n, out uint w, IntPtr r);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
"@
$target = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $target -or $target.StartTime.ToFileTimeUtc() -ne ${fileTime}) { exit 4 }
[HabblaudConsole]::FreeConsole() | Out-Null
$attached = [HabblaudConsole]::AttachConsole(${pid})
Stop-Process -Id ${pid} -Force
if (-not $attached) { exit 3 }
for ($i = 0; $i -lt 30 -and (Get-Process -Id ${pid} -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
Start-Sleep -Milliseconds 150
$out = [HabblaudConsole]::CreateFileW('CONOUT$', ([uint32]3221225472), 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
$m = 0
if ([HabblaudConsole]::GetConsoleMode($out, [ref]$m)) { [HabblaudConsole]::SetConsoleMode($out, $m -bor 4) | Out-Null }
$s = ${reset}
$w = 0
[HabblaudConsole]::WriteConsoleW($out, $s, $s.Length, [ref]$w, [IntPtr]::Zero) | Out-Null
[HabblaudConsole]::CloseHandle($out) | Out-Null
$in = [HabblaudConsole]::CreateFileW('CONIN$', ([uint32]3221225472), 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ([HabblaudConsole]::GetConsoleMode($in, [ref]$m)) {
  # Sem entrada VT (0x200) e com processamento, linha e eco: o shell volta a receber teclas normais.
  [HabblaudConsole]::SetConsoleMode($in, (($m -band (-bnot 0x200)) -bor 0x7)) | Out-Null
}
[HabblaudConsole]::CloseHandle($in) | Out-Null
[HabblaudConsole]::FreeConsole() | Out-Null
`;
}

/**
 * Terminates `pid` (only if process started at `fileTime`) and resets terminal modes. If helper fails
 * before terminating, terminates directly as long as `stillSame` confirms matching process (terminal
 * may retain active console modes).
 */
export function killWithConsoleReset(pid: number, fileTime: string, stillSame: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error(tr('pid inválido')));
  if (!/^\d+$/.test(fileTime)) return Promise.reject(new Error(tr('início do processo desconhecido')));
  const encoded = Buffer.from(script(pid, fileTime), 'utf16le').toString('base64');
  return new Promise((ok, fail) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs },
      (err) => {
        if ((err as { code?: unknown } | null)?.code === 4) return fail(new Error(tr('o processo não é mais aquela sessão')));
        void stillSame()
          .then((same) => {
            if (same) process.kill(pid);
          })
          .catch(() => undefined)
          .finally(ok);
      },
    );
  });
}
