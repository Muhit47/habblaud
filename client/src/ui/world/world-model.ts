// Habblaud World in the UI, pure part (DOM-free): when the World window and launch popups
// appear, section state machine, password rules, player name and traits, and error text. These are
// client-side advance checks for immediate feedback: the server decides (e.g. name still goes through
// blocked words list that only it has). Also the "Your building" card (Phase 2): state, counts, reason for
// a rejected payload, top bar chip, and when theme goes to world. Phase 6: "Account and data" screen (inactivity
// notice, downloading data, deleting account), email appeal (suspended/banned account, "unverified"
// building), and world maintenance. UI lives in settings-world.ts, building.ts, world-chip.ts, and
// world-popups.ts.
import { PART_KEYS, type AppearanceParts } from '../../../../shared/appearance';
import type { Appearance } from '../../art/api';
import { appearanceFromSeed } from '../../art/character/appearance';
import { PLAYER_TRAITS } from '../../../../shared/world/protocol';
import { parsePlayerTraits, traitsClash, type TraitId } from '../../../../shared/world/traits';
import type { WorldBuildingStatus, WorldBuildingStop, WorldErrorCode, WorldLastUplink, WorldMeta, WorldServerState, WorldVisibility } from '../../net/world';
import { UPLINK_ACK_ERRORS, type WorldUplink } from '../../../../shared/world/protocol';
import { formatInt, relativeTime } from '../format';
import { isWorldKnownErrorCode } from '../../../../shared/world/api';
import { isIntroId } from '../../../../shared/world/intro';
import { parsePlayerName, type PlayerNameProblem } from '../../../../shared/world/names-rules';
import { tr } from '../../../../shared/i18n';

// ------------------------------------------------------------------ when shown

/**
 * - hidden: no World (without `meta.world`, `enabled: false`, without configured World server which is default:
 *   feature is disabled and nothing appears; or mobile page via remote port);
 * - local_only: opened through another address or without terminal lock: account routes respond 403;
 * - active: can register account, log in, edit character...
 */
export type WorldSectionMode = 'hidden' | 'local_only' | 'active';

export interface WorldGate {
  /** Mobile page (remote port with login). */
  remote: boolean;
  /** Page opened by the local machine (local host). */
  local: boolean;
  /** meta.terminal: Habblaud is only accessible locally (the lock for account actions). */
  terminal: boolean;
  /** Demo mode with FakeWorldApi: no server, no locks apply. */
  fake: boolean;
}

export function worldSectionMode(meta: WorldMeta | undefined, gate: WorldGate): WorldSectionMode {
  if (!meta?.enabled || !meta.configured || meta.state === 'off' || gate.remote) return 'hidden';
  if (!gate.fake && (!gate.local || !gate.terminal)) return 'local_only';
  return 'active';
}

// ------------------------------------------------------------------ launch popups (world-popups.ts)

/**
 * Has character been created? Local server only puts `scene` (and `building`) in meta.world with approved account and
 * created character (server/world/service.ts: `hasBuilding`); demo mode does the same. Before that meta does not
 * specify anything about character (snapshot goes to mobile and timeline), and that suffices here.
 */
export function hasCharacter(meta: WorldMeta | undefined): boolean {
  return !!meta && (meta.scene !== undefined || meta.building !== undefined);
}

/** Key for legacy invite card (up to 0.11): only `never` ("Do not show again") value remains valid. */
export const INVITE_SEEN_KEY = 'habblaud:world-invite-seen';
/** Launch popup: JSON `{shown, last}` (how many times shown and when was last, in ms) or `never`. */
export const LAUNCH_KEY = 'habblaud:world-launch';
/** Popup "You are on the waitlist": `1` after being shown. */
export const WAITLIST_SEEN_KEY = 'habblaud:world-waitlist-seen';
/** Popup "Access granted!": `1` after being shown. */
export const APPROVED_SEEN_KEY = 'habblaud:world-approved-seen';

/** "Not now": launch popup returns after 3 days... */
export const LAUNCH_RETURN_MS = 3 * 24 * 60 * 60 * 1000;
/** ...and appears at most 3 times in total (first time and two reminders). */
export const LAUNCH_MAX_SHOWS = 3;

export type WorldPopupKind = 'launch' | 'waitlist' | 'approved';

/** What this browser has seen of popups (localStorage; without it, page-scoped). */
export interface WorldPopupMemory {
  /** Launch: times shown and last timestamp; `never` = "Do not show again" or account created. */
  launch: { shown: number; last: number } | 'never' | null;
  waitlistSeen: boolean;
  approvedSeen: boolean;
}

export interface WorldPopupDecision {
  show: WorldPopupKind | null;
  /** Memory after this evaluation (with popup counted), or null if unchanged. */
  memory: WorldPopupMemory | null;
}

export const EMPTY_POPUP_MEMORY: WorldPopupMemory = { launch: null, waitlistSeen: false, approvedSeen: false };

/** Reads popup memory from raw keys (legacy `never` counts as "never"; `shown` does not block new launch). */
export function parsePopupMemory(raw: { launch: string | null; legacy: string | null; waitlist: string | null; approved: string | null }): WorldPopupMemory {
  let launch: WorldPopupMemory['launch'] = null;
  if (raw.launch === 'never' || raw.legacy === 'never') launch = 'never';
  else if (raw.launch) {
    try {
      const v = JSON.parse(raw.launch) as { shown?: unknown; last?: unknown };
      if (v && typeof v === 'object' && typeof v.shown === 'number' && typeof v.last === 'number' && Number.isFinite(v.shown) && Number.isFinite(v.last)) {
        launch = { shown: Math.max(0, Math.floor(v.shown)), last: Math.max(0, v.last) };
      }
    } catch {
      // malformed value: treat as never shown
    }
  }
  return { launch, waitlistSeen: raw.waitlist !== null, approvedSeen: raw.approved !== null };
}

/** What to write to each key (null = delete). */
export function serializePopupMemory(m: WorldPopupMemory): { launch: string | null; waitlist: string | null; approved: string | null } {
  return {
    launch: m.launch === 'never' ? 'never' : m.launch ? JSON.stringify(m.launch) : null,
    waitlist: m.waitlistSeen ? '1' : null,
    approved: m.approvedSeen ? '1' : null,
  };
}

/**
 * Which Habblaud World popup to display now (one at a time, depending on account state), and what to save in memory:
 * - launch: without account ("What's new: Habblaud World"); returns every 3 days up to 3 times, or never again after
 *   "Do not show again" or an account is created (any state other than `logged_out` saves `never`);
 * - waitlist: on waitlist, once per browser (right after registration or when opening page while waiting);
 * - approved: access granted and character not yet created, once per browser.
 * Only on local computer with World server configured; never in timelapse, demo mode, or via
 * mobile port. Memory is saved when the popup appears (closing page while open counts).
 */
export function nextWorldPopup(meta: WorldMeta | undefined, gate: WorldGate & { replaying: boolean }, memory: WorldPopupMemory, now: number): WorldPopupDecision {
  if (gate.fake || gate.replaying || worldSectionMode(meta, gate) !== 'active' || !meta) return { show: null, memory: null };
  if (meta.state === 'logged_out') {
    const l = memory.launch;
    if (l === 'never') return { show: null, memory: null };
    if (l && (l.shown >= LAUNCH_MAX_SHOWS || now - l.last < LAUNCH_RETURN_MS)) return { show: null, memory: null };
    return { show: 'launch', memory: { ...memory, launch: { shown: (l?.shown ?? 0) + 1, last: now } } };
  }
  // With account (on waitlist or approved), launch popup never appears again.
  const base: WorldPopupMemory = memory.launch === 'never' ? memory : { ...memory, launch: 'never' };
  const changed = base !== memory;
  if (meta.state === 'waiting' && !memory.waitlistSeen) return { show: 'waitlist', memory: { ...base, waitlistSeen: true } };
  if (meta.state === 'approved' && !memory.approvedSeen && !hasCharacter(meta)) return { show: 'approved', memory: { ...base, approvedSeen: true } };
  return { show: null, memory: changed ? base : null };
}

// ------------------------------------------------------------------ section state machine

export type WorldScreen =
  // without account (state 'logged_out')
  | 'welcome'
  | 'register'
  | 'login'
  | 'verify'
  | 'forgot'
  | 'reset'
  // with account ('waiting' or 'approved')
  | 'home'
  | 'character'
  | 'visibility'
  | 'devices'
  // "Account and data" (Phase 6): inactivity warning, download data, and delete account
  | 'account'
  // Blocked (Phase 5): blocked users to unblock
  | 'blocked';

/** Short flash notice at the top of section after an action (dismissed on next navigation). */
export type WorldFlash = 'code_sent' | 'code_resent' | 'password_changed' | 'signed_out' | 'character_saved' | 'device_revoked';

export interface WorldUi {
  /** Account state according to latest GET /api/world/status (before it, from snapshot). */
  server: WorldServerState | null;
  screen: WorldScreen;
  /** Entered email: passes from register to code, forgot-password to new password and login. */
  email: string;
  /** Player name entered during registration: preserved if returning from code screen. */
  name: string;
  flash: WorldFlash | null;
}

export type WorldUiEvent =
  | { type: 'server'; state: WorldServerState }
  | { type: 'go'; screen: WorldScreen }
  /** Registration accepted (with reserved player name) or unconfirmed email login: code sent to email. */
  | { type: 'code_sent'; email: string; name?: string }
  /** "Forgot password": reset code sent to email. */
  | { type: 'reset_code_sent'; email: string }
  | { type: 'password_changed' }
  /** Signed in (code confirmed or login): entry screen notice no longer applies. */
  | { type: 'signed_in' }
  | { type: 'flash'; flash: WorldFlash };

const SIGNED_OUT: readonly WorldScreen[] = ['welcome', 'register', 'login', 'verify', 'forgot', 'reset'];
const SIGNED_IN: readonly WorldScreen[] = ['home', 'character', 'visibility', 'devices', 'account', 'blocked'];

/** Possible screens in each account state (the first is entry screen). */
export function screensFor(state: WorldServerState): readonly WorldScreen[] {
  if (state === 'waiting' || state === 'approved') return SIGNED_IN;
  if (state === 'logged_out') return SIGNED_OUT;
  return [];
}

export function initialWorldUi(): WorldUi {
  return { server: null, screen: 'welcome', email: '', name: '', flash: null };
}

/** Is screen still valid for account state? If not, returns to entry screen (e.g. logged out -> welcome). */
function fit(s: WorldUi): WorldUi {
  if (!s.server) return s;
  const allowed = screensFor(s.server);
  if (!allowed.length || allowed.includes(s.screen)) return s;
  return { ...s, screen: allowed[0] };
}

export function worldReduce(s: WorldUi, e: WorldUiEvent): WorldUi {
  switch (e.type) {
    case 'server':
      return fit({ ...s, server: e.state });
    case 'go':
      return fit({ ...s, screen: e.screen, flash: null });
    case 'code_sent':
      return fit({ ...s, screen: 'verify', email: e.email, name: e.name ?? s.name, flash: 'code_sent' });
    case 'reset_code_sent':
      return fit({ ...s, screen: 'reset', email: e.email, flash: 'code_sent' });
    case 'password_changed':
      return fit({ ...s, screen: 'login', flash: 'password_changed' });
    case 'signed_in':
      return { ...s, flash: null };
    case 'flash':
      return { ...s, flash: e.flash };
  }
}

// ------------------------------------------------------------------ email, code and password

export function normalizeEmail(raw: string): string {
  return raw.normalize('NFC').trim();
}

export function emailLooksValid(raw: string): boolean {
  const e = normalizeEmail(raw);
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Email verification code: only digits from entered or pasted text ("123 456" is valid). */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

export function codeLooksValid(raw: string): boolean {
  return /^\d{6}$/.test(normalizeCode(raw));
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type PasswordProblem = 'short' | 'long' | 'email' | 'repeated';

/**
 * Password rules verifiable client-side: 12 to 128 characters (NFC), not matching email, and not
 * purely repetitive ("aaaaaaaaaaaa", "abcabcabcabc"). Leaked password checking is done by server.
 */
export function passwordProblem(password: string, email = ''): PasswordProblem | null {
  const p = password.normalize('NFC');
  const n = [...p].length;
  if (n < PASSWORD_MIN) return 'short';
  if (n > PASSWORD_MAX) return 'long';
  const mail = normalizeEmail(email).toLowerCase();
  const lower = p.toLowerCase();
  if (mail && (lower === mail || lower === mail.split('@')[0])) return 'email';
  if (/^(.+?)\1+$/su.test(p)) return 'repeated';
  return null;
}

export function passwordProblemText(p: PasswordProblem): string {
  switch (p) {
    case 'short':
      return tr('A senha precisa ter pelo menos 12 caracteres.');
    case 'long':
      return tr('A senha pode ter no máximo 128 caracteres.');
    case 'email':
      return tr('A senha não pode ser o seu e-mail.');
    case 'repeated':
      return tr('A senha não pode ser só uma repetição (como "aaaaaaaaaaaa").');
  }
}

// ------------------------------------------------------------------ player name

// Rules and uniqueness key: shared/world/names-rules.ts (same as world server, except blocked words
// list which only it has). Here we only have user-facing text for each reason.

export function nameProblemText(p: PlayerNameProblem): string {
  switch (p) {
    case 'type':
    case 'length':
      return tr('O nome precisa ter de 3 a 20 caracteres.');
    case 'invisible':
      return tr('Tire do nome os caracteres invisíveis e os espaços especiais.');
    case 'chars':
      return tr('Use só letras, números, espaço, _ - e . no nome.');
    case 'scripts':
      return tr('Use letras de um só alfabeto no nome.');
    case 'no_letter':
      return tr('O nome precisa ter pelo menos uma letra.');
    case 'reserved':
      return tr('Este nome é reservado. Escolha outro.');
  }
}

// ------------------------------------------------------------------ traits

// IDs, labels, clashing pairs and selection validation: shared/world/traits.ts (same as server).

/**
 * Can trait `t` be toggled given current selections? Selected can always be toggled (to deselect); others cannot
 * when 3 are already picked or when clashing with an existing one (`with` specifies which).
 */
export function traitBlock(selected: readonly TraitId[], t: TraitId): { reason: 'full' } | { reason: 'clash'; with: TraitId } | null {
  if (selected.includes(t)) return null;
  const clash = selected.find((s) => traitsClash(s, t));
  if (clash) return { reason: 'clash', with: clash };
  if (selected.length >= PLAYER_TRAITS.max) return { reason: 'full' };
  return null;
}

/** Toggles selection (no effect if trait is blocked). */
export function toggleTrait(selected: readonly TraitId[], t: TraitId): TraitId[] {
  if (selected.includes(t)) return selected.filter((s) => s !== t);
  return traitBlock(selected, t) ? [...selected] : [...selected, t];
}

/** 2 or 3 known traits, non-repeating and without clashing pairs (parsePlayerTraits, server rule). */
export function traitsValid(traits: readonly unknown[]): traits is TraitId[] {
  return parsePlayerTraits(traits) !== null;
}

// ------------------------------------------------------------------ character

/** Fixed draft seed: player has no seed (full `parts` applies), so this only provides starting point. */
export const PLAYER_DRAFT_SEED = 0x5eed;

/**
 * All appearance parts (the 13 in PART_KEYS). World character is sent without seed: a partial `parts` would
 * be filled differently in each place rendering it.
 */
export function fullParts(a: Appearance): AppearanceParts {
  const full: Record<string, string> = {};
  for (const k of PART_KEYS) {
    const v = k === 'facialHair' ? (a.facialHair ?? 'none') : k === 'bottomStyle' ? (a.bottomStyle ?? 'pants') : a[k];
    full[k] = v;
  }
  return full as AppearanceParts;
}

/** Initial editor appearance: saved character (parts overlaid on fixed seed) or randomized. */
export function draftAppearance(look: 'f' | 'm', parts?: AppearanceParts, seed = PLAYER_DRAFT_SEED): Appearance {
  return appearanceFromSeed(seed, { look, parts });
}

export type CharacterProblem = { field: 'name'; problem: PlayerNameProblem } | { field: 'traits' } | { field: 'intro' };

/** What is missing to save character (first problem found), or null. */
export function characterProblem(d: { name: string; traits: readonly TraitId[]; intro: string | null }): CharacterProblem | null {
  const name = parsePlayerName(d.name);
  if (!name.ok) return { field: 'name', problem: name.problem };
  if (!traitsValid(d.traits)) return { field: 'traits' };
  if (!d.intro || !isIntroId(d.intro)) return { field: 'intro' };
  return null;
}

// ------------------------------------------------------------------ visibility

export const DEFAULT_VISIBILITY: Readonly<WorldVisibility> = {
  mode: 'live',
  closed: false,
  hideCountry: false,
  tokensVisible: true,
  leaderboard: false,
  compactions: false,
  knocks: false,
};

/** Visibility screen toggles (inactivity notice is in "Account and data"). */
export type VisibilitySwitch = Exclude<keyof WorldVisibility, 'mode' | 'notifyInactivity'>;

/** Switch order on screen. */
export const VISIBILITY_SWITCHES: readonly VisibilitySwitch[] = ['closed', 'hideCountry', 'tokensVisible', 'leaderboard', 'compactions', 'knocks'];

// ------------------------------------------------------------------ account and data (Phase 6)

/** Is email notice before removing inactive building enabled? Missing info defaults to: yes. */
export function notifyInactivityOn(v: Pick<WorldVisibility, 'notifyInactivity'> | undefined): boolean {
  return v?.notifyInactivity !== false;
}

/** Filename for "Download my data" (matching GET /api/world/export attachment). */
export const EXPORT_FILENAME = 'habblaud-world-dados.json';

/** Destination for appeals (suspended/banned account, "unverified" building) and data requests. */
export const APPEAL_EMAIL = 'privacidade@habblaud.com';

/** Fixed appeal subject (in Portuguese: inbox filter for support), with account ID when known. */
export const APPEAL_SUBJECT = 'Recurso Habblaud World';

/** Link "Appeal via email": mailto to APPEAL_EMAIL with subject and account ID if available. */
export function appealMailto(accountId?: string): string {
  const id = accountId && /^[A-Za-z0-9_-]{1,64}$/.test(accountId) ? accountId : '';
  return `mailto:${APPEAL_EMAIL}?subject=${encodeURIComponent(id ? `${APPEAL_SUBJECT} ${id}` : APPEAL_SUBJECT)}`;
}

/** Badge for building marked as "unverified" (WorldBuildingPublic.unverified), for city card. */
export function unverifiedLabel(): string {
  return tr('Não verificado');
}

/** What badge means for viewers in city (badge tooltip on card). */
export function unverifiedHint(): string {
  return tr('Os números deste prédio pareceram fora do normal e estão em revisão; enquanto isso, ele fica fora de placares e destaques.');
}

// ------------------------------------------------------------------ errors

/** What UI action was being performed: same code ("invalid") has different meanings per action. */
export type WorldAction =
  | 'status'
  | 'register'
  | 'verify'
  | 'login'
  | 'logout'
  | 'resend'
  | 'forgot'
  | 'reset'
  | 'character'
  | 'visibility'
  | 'devices'
  | 'revoke'
  | 'pause'
  | 'resume'
  | 'join'
  | 'leave'
  | 'sent'
  | 'theme'
  /** World scene command (POST /api/world/cmd) rejected by local server. */
  | 'scene'
  /** "Download my data" (GET /api/world/export). */
  | 'export'
  /** "Delete account" (request code or confirm). */
  | 'delete'
  /** Inactivity notice (PUT /api/world/visibility). */
  | 'inactivity'
  /** Phase 5: "While you were away" viewed and Unblock. */
  | 'summary'
  | 'unblock';

/**
 * Error text (server `message`, in English, is never displayed directly). Switch covers all WorldErrorCode (the
 * compiler enforces text for every new code); unrecognized codes receive fallback generic text.
 */
export function worldErrorText(raw: WorldErrorCode | string, action: WorldAction): string {
  const code: WorldErrorCode = isWorldKnownErrorCode(raw) || raw === 'offline' || raw === 'forbidden' ? raw : 'unknown';
  switch (code) {
    case 'invalid_code':
      return tr('Código errado ou vencido. Confira o e-mail ou peça outro código.');
    case 'invalid_credentials':
      return tr('E-mail ou senha não conferem.');
    case 'email_not_verified':
      return tr('Falta confirmar o e-mail: mandamos um código novo.');
    case 'banned':
      return tr('Esta conta foi banida do Habblaud World. Para recorrer, responda ao e-mail do banimento.');
    case 'suspended':
      return tr('Esta conta está suspensa no Habblaud World por enquanto.');
    case 'unauthorized':
    case 'not_logged_in':
    case 'session_expired':
      return tr('A sessão do Habblaud World neste computador terminou. Entre de novo.');
    case 'name_taken':
      return tr('Este nome já está em uso no mundo. Escolha outro.');
    case 'name_invalid':
      return tr('Nome inválido: de 3 a 20 caracteres, com letras de um só alfabeto, números, espaço, _ - e .');
    case 'name_blocked':
      return tr('Este nome não é permitido. Escolha outro.');
    case 'name_cooldown':
      return tr('O nome só pode ser trocado uma vez a cada 30 dias.');
    case 'password_invalid':
      return tr('A senha precisa ter de 12 a 128 caracteres.');
    case 'password_weak':
      return tr('Senha fraca: não use o e-mail, o nome de jogador nem só repetição.');
    case 'password_pwned':
      return tr('Esta senha aparece em vazamentos de dados conhecidos. Escolha outra.');
    case 'invalid_email':
      return tr('E-mail inválido. Confira o endereço.');
    case 'altcha_required':
    case 'altcha_invalid':
    case 'altcha_failed':
      return tr('A verificação anti-robô não passou. Tente de novo em instantes.');
    case 'device_limit':
      return tr('Esta conta já tem 3 computadores; revogue um em Dispositivos.');
    case 'no_player':
      return tr('Crie o personagem primeiro.');
    case 'unavailable':
      return tr('O Habblaud World está em manutenção. Tente de novo mais tarde.');
    case 'maintenance':
      return tr('O mundo está em manutenção; tentamos de novo em instantes.');
    case 'not_found':
      return action === 'revoke' ? tr('Este dispositivo não está mais na conta.') : tr('O servidor do Habblaud World não encontrou o que foi pedido.');
    case 'invalid_json':
    case 'too_large':
    case 'unsupported_media_type':
    case 'method_not_allowed':
      return tr('O pedido saiu num formato que o servidor não aceita. Atualize o Habblaud e tente de novo.');
    case 'not_configured':
      return tr('O Habblaud World não está ligado neste Habblaud (HABBLAUD_WORLD_URL recusada; veja o log do servidor).');
    case 'rate_limited':
      return action === 'export'
        ? tr('Dá para baixar os dados uma vez por dia. Tente de novo amanhã.')
        : tr('Muitas tentativas seguidas. Espere alguns minutos e tente de novo.');
    case 'network':
    case 'world_unreachable':
    case 'world_timeout':
      return tr('O servidor do Habblaud World não respondeu. Tente de novo em instantes.');
    case 'world_bad_response':
      return tr('O servidor do Habblaud World respondeu algo inesperado. Tente de novo em instantes.');
    case 'account_deleted':
      return tr('A conta do Habblaud World foi excluída. O prédio e o perfil saíram do mundo na hora; o resto é apagado do banco em 7 dias e dos backups em até 30.');
    case 'storage_failed':
      return tr('Não deu para gravar a sessão neste computador: ela vale só até o Habblaud reiniciar.');
    case 'too_many_streams':
      return tr('A cidade já está aberta em outras abas do Habblaud. Feche uma delas para abrir aqui.');
    case 'no_stream':
      return tr('A cena Mundo perdeu a conexão com o Habblaud. Abra a cidade de novo.');
    case 'not_connected':
      if (action === 'unblock') return tr('Sem conexão com o Habblaud World agora: desbloquear precisa do prédio aceso ou da cidade aberta.');
      return tr('Sem conexão com o Habblaud World agora; o Habblaud tenta de novo sozinho.');
    case 'offline':
      return tr('Sem conexão com o Habblaud.');
    case 'forbidden':
    case 'local_only':
      return tr('A conta do World só pode ser mexida pelo próprio computador, com o Habblaud aberto em localhost.');
    case 'terminal_off':
      return tr('A conta do World só pode ser mexida com o Habblaud acessível apenas pelo próprio computador (acesso local, bind 127.0.0.1).');
    case 'invalid':
      switch (action) {
        case 'register':
        case 'reset':
          return tr('O servidor recusou o e-mail ou a senha. A senha precisa ter de 12 a 128 caracteres e não pode estar numa lista de senhas vazadas.');
        case 'character':
          return tr('O servidor recusou o personagem. Confira o nome, os traços (2 ou 3) e a frase de apresentação.');
        case 'visibility':
        case 'inactivity':
          return tr('O servidor recusou as opções de visibilidade.');
        default:
          return tr('O servidor recusou o pedido. Confira os dados e tente de novo.');
      }
    case 'internal':
      return tr('O servidor do mundo teve um erro; tente de novo.');
    case 'world_error':
    case 'unknown':
      return tr('Algo deu errado. Tente de novo em instantes.');
  }
}

// ------------------------------------------------------------------ building in world (Phase 2)

/**
 * "Your building" card state (approved account). Without character, building does not enter world; left world ("Leave
 * world") and paused take precedence over connection (in both no packets uplink); next, server-requested stop
 * (`stopped`, with reason); without open connection, Habblaud is connecting or retrying.
 */
export type BuildingState = 'connected' | 'reconnecting' | 'paused' | 'stopped' | 'left' | 'no_player';

export function buildingState(b: WorldBuildingStatus | undefined, hasPlayer: boolean): BuildingState {
  if (!hasPlayer) return 'no_player';
  if (b?.left) return 'left';
  if (b?.paused) return 'paused';
  if (b?.stopped) return 'stopped';
  return b?.connected ? 'connected' : 'reconnecting';
}

/** What card displays when world server stopped the building (`goodbye`), by reason. */
export function buildingStopView(reason: WorldBuildingStop): { label: string; desc: string; toggle: BuildingView['toggle'] } {
  switch (reason) {
    case 'update':
      return { label: tr('Atualize o Habblaud'), desc: tr('Esta versão do Habblaud não entra mais no mundo. Atualize para o prédio voltar a acender.'), toggle: null };
    case 'other-device':
      return {
        label: tr('Conectado em outro computador'),
        desc: tr('A sua conta conectou o prédio em outro computador, e este parou de enviar.'),
        toggle: { action: 'resume', text: tr('Trazer para este computador'), hint: tr('O prédio volta a subir daqui, e o outro computador para de enviar.') },
      };
    case 'banned':
      return { label: tr('Conta banida'), desc: tr('O Habblaud World baniu esta conta: o prédio saiu do mundo e nada mais sai deste computador.'), toggle: null };
    case 'suspended':
      return {
        label: tr('Conta suspensa'),
        desc: tr('Esta conta está suspensa no Habblaud World: o prédio fica apagado e nada sai deste computador.'),
        toggle: { action: 'resume', text: tr('Tentar de novo'), hint: tr('Se a suspensão já acabou, o prédio volta a acender.') },
      };
    case 'waiting':
      return { label: tr('Na lista de espera'), desc: tr('A conta voltou para a lista de espera: o prédio sai do mundo até o acesso ser liberado de novo.'), toggle: null };
    case 'no_player':
      return { label: tr('Sem personagem'), desc: tr('O mundo não encontrou o seu personagem: crie de novo para o prédio voltar.'), toggle: null };
    case 'unauthorized':
      return { label: tr('Entre de novo'), desc: tr('O servidor do mundo não reconheceu este computador: entre de novo na conta.'), toggle: null };
    case 'deleted':
      return { label: tr('Conta excluída'), desc: tr('A conta do Habblaud World foi excluída: o prédio e o perfil saíram do mundo e nada mais sai deste computador.'), toggle: null };
  }
}

/**
 * Reasons world server rejects an uplink payload (`uplink.ack {error}`, protocol UPLINK_ACK_ERRORS); codes
 * unknown to this version arrive as `internal` (net/world.ts) and anything outside list becomes generic fallback.
 */
export const UPLINK_REJECT_CODES = UPLINK_ACK_ERRORS;

/** Why world rejected uplink payload, in a single sentence. */
export function uplinkRejectText(code: string | undefined): string {
  switch (code) {
    case 'schema':
      return tr('O pacote saiu fora do formato do protocolo. Atualize o Habblaud.');
    case 'limits':
      return tr('O escritório passou dos limites do mundo (64 andares, 64 agentes por andar, 256 agentes ou 64 KB).');
    case 'name_pool':
      return tr('Um nome de personagem não está na lista de nomes do mundo.');
    case 'parts':
      return tr('Uma peça de aparência está fora das paletas do editor.');
    case 'ids':
      return tr('Um código de andar ou de agente está fora do formato.');
    case 'rate':
      return tr('Remessas demais em pouco tempo (o limite é 12 por minuto). A próxima vai normalmente.');
    case 'internal':
      return tr('Um erro no servidor do mundo. A próxima remessa tenta de novo.');
    case 'left':
      return tr('A conta saiu do mundo (por este ou por outro computador): nada mais sai até você voltar ao mundo.');
    case 'implausible':
      return tr('O pacote contradiz o anterior de um jeito que o Habblaud não produz: o mundo o descartou, e o prédio fica com o último aceito. As próximas remessas vão normalmente.');
    default:
      return tr('Um motivo que esta versão do Habblaud não conhece.');
  }
}

export interface BuildingView {
  state: BuildingState;
  /** State label ("Connected", "Paused"...). */
  label: string;
  /** What state means, in one or two sentences. */
  desc: string;
  /** "2 floors", "3 agents", "Last uplink: 12 s ago" (empty without character). */
  stats: string[];
  /** Reason last uplink was rejected (null: accepted or awaiting response). */
  rejected: string | null;
  /** Pause button text and explanation (null: no button). */
  toggle: { action: 'pause' | 'resume' | 'join'; text: string; hint: string } | null;
  /** Displays "Leave world" (active building exists in world to withdraw). */
  leave: boolean;
  /** Building marked as "unverified" (what this means for owner), or null. */
  unverified: string | null;
  /** "Appeal via email" (suspended/banned account) or "Contest via email" (unverified), or null. */
  appeal: { text: string; hint: string } | null;
}

/** What card knows beyond building: world maintenance status (latest /v1/me returned 503 `maintenance`). */
export interface BuildingViewOptions {
  maintenance?: boolean;
}

/** "Appeal via email", with explanation beside it. */
function appealFor(kind: 'appeal' | 'contest'): { text: string; hint: string } {
  return kind === 'appeal'
    ? { text: tr('Recorrer por e-mail'), hint: tr('Abre um e-mail para {0}: conte o que aconteceu, e uma pessoa revê o caso.', [APPEAL_EMAIL]) }
    : { text: tr('Contestar por e-mail'), hint: tr('Abre um e-mail para {0}: se for engano, uma pessoa revê os números e tira o selo.', [APPEAL_EMAIL]) };
}

/** "1 byte", "1,174 bytes". */
export function bytesText(n: number): string {
  return n === 1 ? tr('1 byte') : tr('{0} bytes', [formatInt(n)]);
}

/** "1 floor", "3 floors". */
export function floorsText(n: number): string {
  return n === 1 ? tr('1 andar') : tr('{0} andares', [formatInt(n)]);
}

/** "1 agent", "3 agents". */
export function agentsText(n: number): string {
  return n === 1 ? tr('1 agente') : tr('{0} agentes', [formatInt(n)]);
}

/** "1 visitor now", "3 visitors now". */
export function visitorsText(n: number): string {
  return n === 1 ? tr('1 visitante agora') : tr('{0} visitantes agora', [formatInt(n)]);
}

/**
 * "Someone entered your building" alert: once per connection, when visitor count (meta.world.building
 * .visitors) transitions from zero to non-zero. Without count (connection lost, closed to visits), alert re-arms.
 * Initial count seen on page load does not alert (visitor was already present before opening).
 */
export interface VisitorAlertState {
  /** Seen a count (or lack of one) on this page. */
  started: boolean;
  /** Last count (undefined: no count). */
  last: number | undefined;
  /** Already alerted on this connection. */
  notified: boolean;
}

export const VISITOR_ALERT_START: VisitorAlertState = { started: false, last: undefined, notified: false };

export function nextVisitorAlert(s: VisitorAlertState, visitors: number | undefined, enabled: boolean): { state: VisitorAlertState; notify: boolean } {
  const n = typeof visitors === 'number' && visitors > 0 ? visitors : visitors === 0 ? 0 : undefined;
  if (!s.started) return { state: { started: true, last: n, notified: n !== undefined && n > 0 }, notify: false };
  if (n === undefined) return { state: { started: true, last: undefined, notified: false }, notify: false };
  const arrived = n > 0 && (s.last ?? 0) === 0;
  const notify = arrived && !s.notified && enabled;
  return { state: { started: true, last: n, notified: s.notified || arrived }, notify };
}

/** Everything "Your building" card displays, pure data without DOM. */
export function buildingView(b: WorldBuildingStatus | undefined, hasPlayer: boolean, now: number, opts: BuildingViewOptions = {}): BuildingView {
  const v = buildingViewBase(b, hasPlayer, now, opts);
  // Suspended or banned: email appeal. Unverified (and building still in world): badge and contest link.
  if (v.state === 'stopped' && (b?.stopped === 'banned' || b?.stopped === 'suspended')) return { ...v, appeal: appealFor('appeal') };
  if (b?.unverified && v.state !== 'stopped' && v.state !== 'left' && v.state !== 'no_player') {
    return {
      ...v,
      unverified: tr('O mundo marcou o seu prédio como "não verificado": os números pareceram fora do normal e estão em revisão. Ele continua no mundo, mas fora de placares e destaques.'),
      appeal: appealFor('contest'),
    };
  }
  return v;
}

function buildingViewBase(b: WorldBuildingStatus | undefined, hasPlayer: boolean, now: number, opts: BuildingViewOptions): BuildingView {
  const state = buildingState(b, hasPlayer);
  const extra = { unverified: null, appeal: null };
  const floors = b?.floors ?? 0;
  const agents = b?.agents ?? 0;
  const stats =
    state === 'no_player' || state === 'left'
      ? []
      : [
          floorsText(floors),
          agentsText(agents),
          b?.lastUplinkAt ? tr('Última remessa: {0}', [relativeTime(b.lastUplinkAt, now)]) : tr('Nenhuma remessa ainda'),
          ...(b?.visitors ? [`👀 ${visitorsText(b.visitors)}`] : []),
        ];
  const live = state === 'connected' || state === 'reconnecting' || state === 'paused';
  const rejected = live && b?.lastAck?.ok === false ? uplinkRejectText(b.lastAck.error) : null;
  const later = tr('Pausado por 30 dias, o prédio some do mapa e, 30 dias depois, é retirado; retomar antes disso traz de volta, no mesmo lote.');
  switch (state) {
    case 'no_player':
      return { state, label: tr('Sem personagem'), desc: tr('Crie o seu personagem: o prédio entra no mundo junto com ele.'), stats, rejected, toggle: null, leave: false, ...extra };
    case 'left':
      return {
        state,
        label: tr('Fora do mundo'),
        desc: tr('Você saiu do mundo: o prédio foi retirado e o lote, liberado. Dá para andar pela cidade; nada do escritório sai deste computador.'),
        stats,
        rejected: null,
        toggle: { action: 'join', text: tr('Voltar ao mundo'), hint: tr('Voltar cria um prédio novo, em outro lote; a conta e o personagem são os mesmos.') },
        leave: false,
        ...extra,
      };
    case 'stopped': {
      const reason = b!.stopped!;
      const v = buildingStopView(reason);
      return { state, ...v, stats, rejected, leave: reason === 'update' || reason === 'other-device' || reason === 'suspended', ...extra };
    }
    case 'paused':
      return {
        state,
        label: tr('Pausado'),
        desc: tr('Pausado: seu prédio está apagado, mas você pode andar pela cidade. Nada do escritório sai deste computador.'),
        stats,
        rejected,
        toggle: { action: 'resume', text: tr('Retomar'), hint: `${tr('Retomar volta a enviar e acende o prédio.')} ${later}` },
        leave: true,
        ...extra,
      };
    case 'connected':
    case 'reconnecting': {
      const connected = state === 'connected';
      const first = !b?.lastUplinkAt;
      // Without connection and world under maintenance (503 `maintenance`): Habblaud retries with backoff.
      const maintenance = !connected && !!opts.maintenance;
      return {
        state,
        label: connected ? tr('Conectado') : maintenance ? tr('Em manutenção') : first ? tr('Conectando…') : tr('Reconectando…'),
        desc: connected
          ? tr('Aceso no mundo: um andar por sala aberta e cada personagem no status de agora. Os tokens, se você deixar, aparecem só em faixas, no medidor da fachada.')
          : maintenance
            ? tr('O mundo está em manutenção; tentamos de novo em instantes.')
            : first
              ? tr('O prédio acende com a primeira remessa.')
              : tr('Sem conexão com o mundo agora: o Habblaud tenta de novo sozinho. Com 2 minutos sem notícias, o prédio apaga.'),
        stats,
        rejected,
        toggle: { action: 'pause', text: tr('Pausar'), hint: `${tr('Pausar interrompe o envio na hora e apaga o prédio no mundo.')} ${later}` },
        leave: true,
        ...extra,
      };
    }
  }
}

/** Difference between pausing and leaving world (PLANO.md, section 2.6), beside "Leave world" button. */
export function leaveHint(): string {
  return tr(
    'Pausar apaga o prédio e guarda o lote: retomar traz de volta, no mesmo lugar. Sair do mundo retira o prédio na hora e libera o lote; a conta e o personagem continuam, e voltar depois cria um prédio novo, em outro lote.',
  );
}

export type AckKind = 'accepted' | 'rejected' | 'pending';

/**
 * World server response to uplink payload, for "View sent payload" modal. Accepted, with bytes counted by world
 * (matching `sentBytes` when payload arrived intact).
 */
export function ackView(ack: WorldLastUplink['ack'], sentBytes?: number): { kind: AckKind; label: string; reason: string | null } {
  if (!ack) return { kind: 'pending', label: tr('Sem resposta do mundo ainda.'), reason: null };
  if (ack.ok) {
    const reason =
      ack.bytes === undefined ? null : ack.bytes === sentBytes ? tr('O mundo recebeu os mesmos {0}.', [bytesText(ack.bytes)]) : tr('O mundo contou {0}.', [bytesText(ack.bytes)]);
    return { kind: 'accepted', label: tr('Aceita pelo mundo.'), reason };
  }
  return { kind: 'rejected', label: tr('Recusada pelo mundo.'), reason: uplinkRejectText(ack.error) };
}

/** Payload formatted for modal view: same object sent over wire, indented with 2 spaces. */
export function prettyUplink(uplink: WorldUplink): string {
  return JSON.stringify(uplink, null, 2);
}

/**
 * Is Appearance › Office theme selection synced to building (PUT /api/world/theme)? Only with World enabled,
 * account approved, and on page where account settings are editable (route is local only).
 */
export function themeGoesToWorld(meta: WorldMeta | undefined, gate: WorldGate): boolean {
  return worldSectionMode(meta, gate) === 'active' && meta?.state === 'approved';
}

export type WorldChipState = 'live' | 'paused' | 'reconnecting' | 'stopped';

/**
 * Top bar status chip ("🏙️ in world" / "⏸ paused" / "⚠️ stopped"): only with `meta.world.building` (approved account)
 * and never via mobile port. If left world, null. Stopped by world server, "stopped" (reason shown in card).
 * Without active connection, only appears if building has previously sent an uplink (before that, not in world).
 */
export function worldChipState(meta: WorldMeta | undefined, gate: WorldGate): WorldChipState | null {
  const b = meta?.building;
  if (!b || b.left || meta.state !== 'approved' || worldSectionMode(meta, gate) === 'hidden') return null;
  if (b.paused) return 'paused';
  if (b.stopped) return 'stopped';
  if (b.connected) return 'live';
  return b.lastUplinkAt ? 'reconnecting' : null;
}
