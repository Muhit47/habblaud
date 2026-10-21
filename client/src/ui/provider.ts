// Tool attribution (Claude Code vs Codex) and copy adjustments per tool. Pure module (no DOM): tested in
// ui/provider.test.ts. In protocol, omitted `provider` implies Claude Code (shared/types.ts); all fallbacks default here.
//
// Visual identity for Codex (unaffiliated styling): account chip is hollow (dark background, outline and text
// in account accent color, stepped corners) and displays a "Codex" tag badge beside the name when space allows.
import type { AccountInfo, OfficeSnapshot, Provider } from '../../../shared/types';
import { shortcutHint } from './model';
import { tr } from '../../../shared/i18n';

/** Tool names as displayed in UI text. */
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', kilo: 'Kilo' };

/** Tool provider for an agent, account, session, or request (omitted = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

/**
 * Does account ID pattern match a Codex directory (".codex", ".codex-work", ".codex~2", "demo:.codex")?
 * Used when account is no longer in current snapshot (e.g. historical log, "My day"): with live account in hand, use its `provider`.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

/** Account provider: snapshot value; otherwise caller hint or ID pattern heuristics. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  if (hint) return hint;
  if (/antigravity/i.test(fallbackId)) return 'antigravity';
  if (/kilo/i.test(fallbackId)) return 'kilo';
  return looksLikeCodexId(fallbackId) ? 'codex' : 'claude';
}

/**
 * Initial letter for account chip when missing from snapshot: first letter after directory prefix
 * (".claude-account2" -> "A", ".codex-work" -> "W"). Default Codex directory (".codex") maps to "X"; Claude Code to
 * "?" (as before). Never returns "." or empty string.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  return provider === 'codex' ? 'X' : '?';
}

/** Displays "Codex" tag badge beside account name (avoids redundancy if name already contains "Codex"). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  return provider === 'codex' && !/codex/i.test(accountName);
}

/** Account chip label (tooltips and screen readers): "Account C (dev@x.com)", "Codex · Team plan". */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  if (!account) return fallbackId ? `${fallbackId}${provider === 'codex' ? ' · Codex' : ''}` : tr('Conta desconhecida');
  if (provider !== 'codex') return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ' · Codex' : '';
  return `${account.name}${tag}${account.plan ? tr(' · plano {0}', [account.plan]) : ''}`;
}

/**
 * Empty office hint text. Shortcuts ("shortcut c or d") only apply to Claude Code accounts derived from
 * shell aliases (Codex account letters are not shortcuts); Codex is mentioned only when configured.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  const keys = shortcutHint(accounts.filter((a) => !isCodex(a)));
  if (!accounts.some(isCodex)) return tr('Abra o Claude Code em qualquer projeto{0} e veja seu agente chegar.', [keys ? ` (${keys})` : '']);
  return tr('Abra o Claude Code{0} ou o Codex em qualquer projeto e veja seu agente chegar.', [keys ? ` (${keys})` : '']);
}

/** Are there pending Codex permission requests: shorter deadlines trigger 1-second interval countdown ticks. */
export function hasCodexPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && isCodex(a.permission) && a.status !== 'offline' && a.status !== 'done');
}

/** Instructions for live Codex monitoring and office approvals (agent drawer and help modal). */
export const CODEX_LIVE_HINT = tr('Para ver o Codex ao vivo e aprovar pelo escritório: `npm run codex:install` e aprove os hooks em `/hooks` no Codex.');

/** Codex approval policies (`approval_policy`), when sent by server in place of permission mode. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: tr('Pergunta antes de quase tudo'),
  'on-request': tr('Pergunta quando precisa'),
  'on-failure': tr('Pergunta quando um comando falha'),
  never: tr('Nunca pergunta'),
};

/** Formats Codex approval policy label (unknown values pass through unchanged). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
