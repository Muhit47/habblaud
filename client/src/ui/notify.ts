// Notifications (opt-in): Browser Notification API for alerts when the tab is hidden, sound effects
// ("needs you" chime, completion pop; routed through UI SoundBoard), and tab title badge count
// when agents are waiting on you.
import type { Notice } from '../../../shared/types';
import type { SoundBoard } from '../audio/board';
import type { UiComponent, UiContext } from './context';
import { computeCounters } from './model';
import { tr } from '../../../shared/i18n';

const BASE_TITLE = 'Habblaud';

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationState(): NotificationState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export class Notifier implements UiComponent {
  private lastTitle = '';

  constructor(
    private ctx: UiContext,
    private sounds: SoundBoard,
  ) {
    ctx.store.on('notice', (n) => this.onNotice(n));
  }

  /** Requests notification permission when toggling the option. Returns final permission state. */
  async enableBrowserNotifications(): Promise<NotificationState> {
    const state = notificationState();
    if (state === 'unsupported' || state === 'denied' || state === 'granted') return state;
    try {
      return await Notification.requestPermission();
    } catch {
      return notificationState();
    }
  }

  render(): void {
    // Always live, even during timelapse: tab title alerts who needs you right now.
    const waiting = computeCounters(this.ctx.store.liveSnapshot).waiting;
    const title = waiting > 0 ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE;
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      document.title = title;
    }
  }

  private onNotice(n: Notice): void {
    const prefs = this.ctx.prefs;
    // Chime plays even with hidden tab (beckoning you back); pop plays only when tab is visible.
    if (n.level === 'alert') this.sounds.play('chime');
    else if (n.level === 'success') this.sounds.play('pop');
    if (n.level === 'alert' && prefs.browserNotifications && document.hidden && notificationState() === 'granted') {
      try {
        const notification = new Notification(tr('Habblaud — precisa de você'), {
          body: n.text,
          tag: n.agentId ?? n.id,
          icon: '/assets/brand/favicon-32.png',
        });
        notification.onclick = () => {
          window.focus();
          if (n.agentId && this.ctx.agent(n.agentId)) this.ctx.select({ type: 'agent', id: n.agentId }, { focus: true });
          notification.close();
        };
      } catch {
        // Some browsers only permit notifications via service worker; in-app toast still appears.
      }
    }
  }
}
