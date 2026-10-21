// External Habblaud World URLs (terms and privacy policy), referenced in Settings, "Your building"
// card, "View sent payload" dialog, and invitation cards.
import { h } from '../dom';

export const WORLD_TERMS_URL = 'https://habblaud.com/world/termos';
export const WORLD_PRIVACY_URL = 'https://habblaud.com/world/privacidade';

/** External link (terms, privacy), opens in new tab. */
export function extLink(text: string, href: string): HTMLAnchorElement {
  return h('a', { class: 'ui-link-btn', text, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } });
}
