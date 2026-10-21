// Text for each world notice in scene (`notice {level, text}`): `text` is a protocol NOTICE_IDS
// id, translated here (server never sends phrases). Certain ids vary based on context:
// in street, waiting on `enter` response (at door), or inside building (evicted).
import { tr } from '../../../../shared/i18n';
import type { NoticeId } from '../../../../shared/world/protocol';

/** Where notice was received: in street, right after `enter` (at door), or inside building. */
export type NoticePlace = 'street' | 'door' | 'inside';

/**
 * Text for a `notice` (`text` is protocol NOTICE_IDS id, translated here; unknown id falls back to
 * generic notice). null = nothing to display (debug-only ids). New protocol id without `case` here
 * fails compilation.
 */
export function noticeText(raw: NoticeId | (string & {}), place: NoticePlace = 'street'): string | null {
  const id = raw as NoticeId;
  switch (id) {
    case 'ignored':
    case 'invalid':
    case 'view_required':
      return null;
    case 'rate_limited':
      return tr('Devagar: o mundo pediu um tempo entre as ações.');
    case 'not_found':
      if (place === 'door') return tr('Este prédio não está no mundo agora.');
      if (place === 'inside') return tr('O prédio saiu do mundo: você voltou para a rua.');
      return tr('Essa pessoa não está mais por perto.');
    case 'street_left':
      return tr('Você ficou um bom tempo parado e saiu da rua: ande para voltar.');
    case 'chunk_full':
      return tr('A área está cheia: só os jogadores mais perto aparecem.');
    case 'afk':
      return tr('Você ficou um tempo parado.');
    case 'server_restart':
      return tr('O Habblaud World vai reiniciar: a conexão cai e volta sozinha.');
    case 'left':
      return tr('Sua conta saiu do mundo: o prédio volta com "Voltar ao mundo", em Configurações.');
    case 'too_far':
      return tr('Chegue mais perto da porta para entrar.');
    case 'closed':
      return place === 'inside' ? tr('O prédio fechou a visitas: você voltou para a rua.') : tr('Este prédio está fechado a visitas.');
    case 'blocked':
      return place === 'inside' ? tr('Você não pode mais ficar neste prédio: voltou para a rua.') : tr('Você não pode entrar neste prédio.');
    case 'full':
      return tr('O prédio está lotado (20 visitantes). Tente daqui a pouco.');
    // Phase 5 (light social). Confirmations (reported, blocked_ok, stamped) are almost always handled immediately
    // by social (city/social.ts and visit-social.ts consume them); if arriving late, they become this notice.
    case 'daily_limit':
      return tr('Limite do dia atingido: amanhã tem mais.');
    case 'already_done':
      return tr('Você já fez isso hoje.');
    case 'reported':
      return tr('Denúncia enviada. Obrigado: a moderação vai olhar.');
    case 'blocked_ok':
      return tr('Bloqueio feito: vocês deixam de se ver.');
    case 'stamped':
      return tr('Carimbo deixado na portaria.');
    default:
      void (id satisfies never);
      return tr('Aviso do Habblaud World.');
  }
}
