// In-office messages (POST /api/messages): common between server, demo, and page.
// Pure code: no Node or DOM APIs.
import { maskSecrets, truncate, type ActivityDescription } from './activity';
import { tr } from './i18n';

/** Maximum message length (characters). */
export const MESSAGE_MAX = 20_000;
/** `Activity.tool` for "Message via Habblaud" activity (not an agent tool: it represents incoming text). */
export const MESSAGE_TOOL = 'HabblaudMessage';
/** Activity detail: beginning of text, masked and truncated (full text only goes to session). */
const DETAIL_MAX = 300;

/**
 * "Message via Habblaud" activity for a message delivered to session (entered it or its queue: does not
 * mean agent has read it yet).
 */
export function describeMessage(text: string): ActivityDescription & { tool: string } {
  const detail = truncate(maskSecrets(text.slice(0, DETAIL_MAX * 4)), DETAIL_MAX);
  return { kind: 'communicate', icon: '✉️', text: tr('Mensagem pelo Habblaud'), tool: MESSAGE_TOOL, ...(detail ? { detail } : {}) };
}
