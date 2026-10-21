// Message box (ui/composer.ts), pure and tested in ui/composer-model.test.ts: when box appears (and
// why not), what Enter key does, status line of each submission, and delivery poll intervals.
// In Codex message enters session queue (`codex queue`) and becomes prompt when idle: "Delivered" reflects
// this; without delivery helper (in Docker, host bridge), the hint refers to `npm run codex:bridge`.
import { MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxStatus, Provider } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

/** Hint for users who have feature enabled, but agent session lacks connected plugin. */
export const PLUGIN_HINT = tr('Para mandar mensagens daqui: npm run mod:install (plugin habblaud-mensagens)');
/** Same hint for Codex agent without deliverer (in Node mode server itself delivers). */
export const CODEX_BRIDGE_HINT = tr('Para mandar mensagens ao Codex: com o Habblaud no Docker, deixe npm run codex:bridge rodando; no modo Node funciona sozinho');

/**
 * - ready: ready to send (main agent with plugin connected, feature enabled, local page);
 * - hint: feature enabled and main agent present, but session lacks plugin (`text` explains how to install);
 * - off: cannot send (`text` explains why). Drawer hides box; terminal shows reason in its place.
 */
export type ComposerMode = { kind: 'ready' } | { kind: 'hint'; text: string } | { kind: 'off'; text: string };

export interface ComposerEnv {
  /** Feature enabled on server (OfficeSnapshot.meta.messages; always in ?mock=1). */
  enabled: boolean;
  /** Page opened from this computer (server only accepts messages this way). */
  local: boolean;
  /** Timelapse: office displayed is from the replayed moment. */
  replaying: boolean;
}

export function composerMode(agent: AgentInfo | undefined, env: ComposerEnv): ComposerMode {
  if (env.replaying) return { kind: 'off', text: tr('Sem mensagens no timelapse: o escritório mostrado é o de outro momento') };
  if (agent?.kind === 'sub') return { kind: 'off', text: tr('Subagentes não recebem mensagens: escreva para o agente principal') };
  if (!agent || agent.status === 'offline' || agent.status === 'done') return { kind: 'off', text: tr('Sessão encerrada') };
  const codex = agent.provider === 'codex';
  if (!env.enabled) return { kind: 'off', text: codex ? tr('Para responder, use o Codex') : tr('Para responder, use o terminal do Claude Code') };
  if (!env.local) return { kind: 'off', text: tr('Para mandar mensagens por aqui, abra o Habblaud por http://localhost (ou 127.0.0.1)') };
  if (!agent.canMessage) return { kind: 'hint', text: codex ? CODEX_BRIDGE_HINT : PLUGIN_HINT };
  return { kind: 'ready' };
}

/** Hint below box (drawer): how message enters session. */
export function composerTip(provider: Provider = 'claude'): string {
  return provider === 'codex'
    ? tr('Entra na fila da sessão e vira o próximo prompt quando o Codex terminar o que está fazendo. Enter manda; Shift+Enter quebra a linha.')
    : tr('Entra na sessão como se você tivesse digitado. Enter manda; Shift+Enter quebra a linha.');
}

/** Sanitized text from box: text as typed, without trailing spaces and blank lines. */
export function messageText(raw: string): string {
  return raw.replace(/\s+$/, '');
}

export function canSend(raw: string): boolean {
  const text = messageText(raw);
  return text.trim().length > 0 && text.length <= MESSAGE_MAX;
}

/** Enter sends; Shift+Enter (and Alt+Enter) line-breaks; IME composing Enter doesn't count. */
export function enterSends(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing;
}

/**
 * Situation of an agent's last submission: `sending` (POST hasn't returned yet), `rejected` (server rejected:
 * text remains in box) or message status on server (OutboxStatus).
 */
export type SendPhase = 'sending' | 'rejected' | OutboxStatus;

export interface SendState {
  phase: SendPhase;
  /** Message id on server (after 201). */
  id?: string;
  error?: string;
  /** Last state change (epoch ms, page clock). */
  at: number;
}

export function isSettled(phase: SendPhase): boolean {
  return phase === 'delivered' || phase === 'failed' || phase === 'rejected';
}

/** "Delivered" disappears automatically after this duration; errors remain until next submission. */
export const DELIVERED_SHOW_MS = 12_000;

/** Status line text ('' = nothing to show). */
export function sendStatusText(s: SendState | undefined, now: number, provider: Provider = 'claude'): string {
  if (!s) return '';
  const codex = provider === 'codex';
  switch (s.phase) {
    case 'sending':
      return tr('Enviando…');
    case 'queued':
      return codex ? tr('Na fila: entregando ao Codex…') : tr('Na fila: esperando a sessão buscar a mensagem…');
    case 'sent':
      return tr('Entregando à sessão…');
    case 'delivered':
      // Delivered = entered session or its queue (if agent busy, enters after turn ends). In
      // Codex it's always the queue: session owner polls every ~10s and only consumes when idle.
      if (now - s.at >= DELIVERED_SHOW_MS) return '';
      return codex
        ? tr('Entregue ✓ na fila da sessão: entra quando o Codex terminar o que está fazendo (até ~10 s)')
        : tr('Entregue ✓ (se o agente estiver ocupado, entra quando ele terminar)');
    case 'rejected':
      return tr('Não foi possível mandar: {0}', [s.error ?? tr('erro desconhecido')]);
    case 'failed':
      return tr('Não foi entregue: {0}', [s.error ?? tr('erro desconhecido')]);
  }
}

/** Delivery polling: server takes up to ~90s to give up (60s in queue + 30s unconfirmed). */
export const POLL_LIMIT_MS = 120_000;

/** Wait time until next poll: faster initially (session checks every 2s), spaced out later. */
export function pollDelay(elapsed: number): number {
  if (elapsed < 10_000) return 700;
  if (elapsed < 40_000) return 1_500;
  return 3_000;
}

export const LOST_ERROR = tr('o Habblaud não conhece mais esta mensagem (ele reiniciou?)');
export const TIMEOUT_ERROR = tr('sem notícia da entrega: confira no terminal do Claude Code');
export const CODEX_TIMEOUT_ERROR = tr('sem notícia da entrega: confira no Codex');
export const OFFLINE_ERROR = tr('não foi possível falar com o Habblaud');

/** Poll deadline expired with no news: where to verify. */
export function timeoutError(provider: Provider = 'claude'): string {
  return provider === 'codex' ? CODEX_TIMEOUT_ERROR : TIMEOUT_ERROR;
}
