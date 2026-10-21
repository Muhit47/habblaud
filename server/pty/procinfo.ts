// Verifies that a PID still belongs to that Claude Code process before killing or taking it over. Session registry
// (<account>/sessions/<pid>.json) can linger after crashes or reboots, and PID may have been reused
// by another user process: "Terminate" could inadvertently signal an unrelated process.
// Compares real process start time (OS) with registry start time and executable name.
import { execFile } from 'node:child_process';
import { basename } from 'node:path';

export interface ProcInfo {
  /** Process start timestamp in ms since Unix epoch. */
  startMs: number;
  /** Executable name (without directory or file extension). */
  name: string;
  /** Exact start timestamp from Windows (FILETIME), matching `procStart` format in Windows registry. */
  fileTime?: string;
}

/** What Claude Code session registry records about process. */
export interface RegisteredProc {
  startedAt?: number;
  procStart?: string;
}

/** Difference between 1601 (FILETIME) and 1970 in ms. */
const FILETIME_EPOCH_MS = 11_644_473_600_000;
/** Registry written right after spawn: actual start up to 2 min earlier (or 5 s later for clock skew). */
const START_BEFORE_MS = 120_000;
const START_AFTER_MS = 5_000;

/** Claude Code executable: `claude`, Node/Bun running npm package, or versioned native binary. */
export function looksLikeClaude(name: string): boolean {
  const n = basename(name.trim()).replace(/\.exe$/i, '');
  return /^(claude|node|bun)$/i.test(n) || /^\d+\.\d+\.\d+/.test(n);
}

/** Does alive process `info` match process that wrote `reg`? */
export function sameProcess(reg: RegisteredProc, info: ProcInfo): boolean {
  if (!looksLikeClaude(info.name)) return false;
  // Windows: registry stores exact FILETIME; when both exist, they must match.
  if (reg.procStart && info.fileTime && /^\d+$/.test(reg.procStart)) return reg.procStart === info.fileTime;
  if (typeof reg.startedAt !== 'number' || !Number.isFinite(reg.startedAt)) return false;
  return info.startMs >= reg.startedAt - START_BEFORE_MS && info.startMs <= reg.startedAt + START_AFTER_MS;
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((ok) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, env }, (err, stdout) => ok(err ? undefined : String(stdout)));
  });
}

/** Start time and executable name of living process (undefined if non-existent or inaccessible). */
export async function readProcInfo(pid: number, platform: NodeJS.Platform = process.platform): Promise<ProcInfo | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToFileTimeUtc(); $p.ProcessName`,
    ]);
    return out === undefined ? undefined : parseWindows(out);
  }
  // macOS and Linux: lstart in English (LC_ALL=C) and executable name.
  const out = await run('ps', ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)], { ...process.env, LC_ALL: 'C', LANG: 'C' });
  return out === undefined ? undefined : parsePs(out);
}

/** PowerShell output: FILETIME on first line, executable name on second line. */
export function parseWindows(out: string): ProcInfo | undefined {
  const [ft, name] = out.trim().split(/\r?\n/).map((s) => s.trim());
  if (!ft || !/^\d+$/.test(ft) || !name) return undefined;
  return { startMs: Number(BigInt(ft) / 10_000n) - FILETIME_EPOCH_MS, name, fileTime: ft };
}

/** ps output: "Mon Oct 12 22:46:14 2026 /path/to/command" (lstart always consists of 5 fields). */
export function parsePs(out: string): ProcInfo | undefined {
  const m = /^\s*(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(out.split('\n')[0] ?? '');
  if (!m) return undefined;
  const startMs = Date.parse(m[1]);
  if (!Number.isFinite(startMs)) return undefined;
  return { startMs, name: basename(m[2]) };
}
