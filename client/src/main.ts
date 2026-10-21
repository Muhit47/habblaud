// Client entrypoint: loads active language dictionary first (only active bundle sent to browser), followed by app
// (client/src/app.ts), as several modules call tr() at load time. If dictionary fails to load, defaults to Portuguese.
import { getLocale, registerDictionary, type Locale } from '../../shared/i18n';

const LOADERS: Partial<Record<Locale, () => Promise<Readonly<Record<string, string>>>>> = {
  en: () => import('../../shared/locales/en').then((m) => m.EN),
  es: () => import('../../shared/locales/es').then((m) => m.ES),
  fr: () => import('../../shared/locales/fr').then((m) => m.FR),
};

const locale = getLocale();
const load = LOADERS[locale];
const dictionary = load ? load().then((d) => registerDictionary(locale, d)).catch(() => undefined) : Promise.resolve();
void dictionary.then(() => import('./app')).then((app) => app.start());
