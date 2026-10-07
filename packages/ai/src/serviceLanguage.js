'use strict';
const { createLanguageDetector } = require('./language');
const { serviceRequest, endpoint } = require('./serviceHttp');

const DEFAULT_LANGUAGE_WORDS = Object.freeze({
  fr: ['le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'est', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'que', 'qui', 'quoi', 'pour', 'dans', 'sur', 'avec', 'pas', 'ne', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'ce', 'cette', 'comment', 'pourquoi', 'quand', 'où', 'merci', 'bonjour', 'salut', 'oui', 'non', 'aide', 'aide-moi', 'explique', 'explique-moi', 'peux', 'veux', 'était', 'sont'],
  en: ['the', 'a', 'an', 'and', 'is', 'are', 'was', 'were', 'i', 'you', 'he', 'she', 'we', 'they', 'what', 'who', 'why', 'how', 'when', 'where', 'for', 'in', 'on', 'with', 'not', 'my', 'your', 'his', 'her', 'our', 'this', 'that', 'thanks', 'thank', 'hello', 'hi', 'yes', 'no', 'help', 'me', 'please', 'explain', 'can', 'could', 'would', 'do', 'does'],
  es: ['el', 'los', 'las', 'una', 'unos', 'unas', 'es', 'son', 'yo', 'tú', 'usted', 'nosotros', 'vosotros', 'ellos', 'qué', 'cómo', 'por', 'para', 'con', 'mi', 'mis', 'hola', 'gracias', 'ayuda', 'explica', 'puedes', 'quiero', 'dónde']
});

function createServiceLanguageDetector(options = {}) {
  const detector = createLanguageDetector({
    ...options, words: options.words || DEFAULT_LANGUAGE_WORDS, fallback: options.fallback || 'fr',
    identify: async (text) => {
      if (!options.baseUrl) return null;
      const data = await serviceRequest(endpoint(options.baseUrl, '/detect'), { fetch: options.fetch, body: { text }, timeoutMs: options.timeoutMs ?? 800 });
      if (typeof data?.lang !== 'string' || !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1) return null;
      return { language: data.lang, confidence: data.confidence };
    }
  });
  return detector;
}
module.exports = { createServiceLanguageDetector, DEFAULT_LANGUAGE_WORDS };
