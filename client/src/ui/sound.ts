// Interface sounds (opt-in): connects the sound board to preferences, plays ambient sounds that
// the world emits (typing, elevator, circles), and unlocks audio on first user gesture.
import { SoundBoard } from '../audio/board';
import type { SoundKind } from '../audio/scheduler';
import type { UiComponent, UiContext } from './context';

export class SoundControl implements UiComponent {
  readonly board = new SoundBoard();
  private previewAt = 0;

  constructor(private ctx: UiContext) {
    this.sync();
    ctx.world.onSound?.((cue) => this.board.play(cue.kind, cue));
    // Browsers only allow audio after a user interaction gesture.
    const unlock = () => {
      if (this.ctx.prefs.sound) void this.board.unlock();
    };
    addEventListener('pointerdown', unlock, { passive: true });
    addEventListener('keydown', unlock);
  }

  render(): void {
    this.sync();
  }

  /** Applies current preferences (master toggle, volume, categories). */
  sync(): void {
    this.board.configure(this.ctx.prefs.sound, this.ctx.prefs.sounds);
  }

  /** Preview sample when adjusting settings (called from click event: unlocks audio). */
  preview(kind: SoundKind = 'pop'): void {
    this.sync();
    const now = performance.now();
    const ready = this.board.unlock();
    if (now - this.previewAt < 250) return;
    this.previewAt = now;
    // the first AudioContext "resume" is asynchronous
    void ready.then(() => this.board.play(kind));
  }
}
