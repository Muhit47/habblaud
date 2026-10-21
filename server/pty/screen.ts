// Screen buffer for interactive terminal (@xterm/headless + @xterm/addon-serialize, optional dependencies
// like node-pty). Late connects, reconnects, or tab changes receive rendered screen with active modes
// initialized by Claude Code (bracketed paste, application keypad, mouse tracking, alternate buffer). Without
// these, raw stream playback drops modes: pasting multiple lines would dispatch separate prompts.
import { errMsg } from '../log';
import type { PtyScreen, ScreenFactory } from './manager';
import { tr } from '../../shared/i18n';

/** Scrollback lines retained per terminal. */
const SCROLLBACK = 5_000;

interface HeadlessTerminal {
  write(data: string, cb?: () => void): void;
  resize(cols: number, rows: number): void;
  loadAddon(addon: unknown): void;
  dispose(): void;
}

interface SerializeAddon {
  serialize(opts?: { scrollback?: number }): string;
}

/** Loads @xterm/headless and serialize addon. Returns null + reason on failure. */
export async function loadHeadlessScreen(): Promise<{ create: ScreenFactory | null; reason?: string }> {
  try {
    const headless = (await import('@xterm/headless')) as unknown as { Terminal?: unknown; default?: { Terminal?: unknown } };
    const serialize = (await import('@xterm/addon-serialize')) as unknown as { SerializeAddon?: unknown; default?: { SerializeAddon?: unknown } };
    const Terminal = (headless.Terminal ?? headless.default?.Terminal) as (new (o: Record<string, unknown>) => HeadlessTerminal) | undefined;
    const Serialize = (serialize.SerializeAddon ?? serialize.default?.SerializeAddon) as (new () => SerializeAddon) | undefined;
    if (!Terminal || !Serialize) return { create: null, reason: tr('@xterm/headless sem Terminal ou SerializeAddon') };
    return {
      create: (cols, rows): PtyScreen => {
        const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
        const ser = new Serialize();
        term.loadAddon(ser);
        return {
          write: (data, done) => term.write(data, done),
          resize: (c, r) => term.resize(c, r),
          serialize: () => ser.serialize({ scrollback: SCROLLBACK }),
          dispose: () => term.dispose(),
        };
      },
    };
  } catch (err) {
    return { create: null, reason: tr('@xterm/headless não instalado ({0})', [errMsg(err)]) };
  }
}
