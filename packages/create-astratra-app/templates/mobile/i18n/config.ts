/**
 * The screen's language, decided once.
 *
 * The device locale is the default, and it is only a default: a person whose
 * phone is in English may want the app in French. The choice, once made, is
 * the session's — the API reads it from the Accept-Language header on every
 * call, so server messages arrive already translated.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'expo-localization';
import en from './locales/en.json';
import fr from './locales/fr.json';

const deviceLanguage = getLocales()[0]?.languageCode || 'en';

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: ['en', 'fr'].includes(deviceLanguage) ? deviceLanguage : 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }
});

export default i18n;
