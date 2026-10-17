/**
 * Shipping errors carry a stable CODE the application can act on, never the
 * provider's raw body and never a key. The sentence shown to a person comes
 * from messageFor(code, language), in French or English.
 */
const { createMessageCatalog } = require('@astratra/i18n-server');

const CODES = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  CREDENTIALS_REFUSED: 'credentials_refused',
  UNAVAILABLE: 'unavailable',
  REJECTED: 'rejected',
  NOT_FOUND: 'not_found',
  CANCEL_REFUSED: 'cancel_refused',
  NO_METHOD: 'no_method',
  SERVICE_POINTS_UNAVAILABLE: 'service_points_unavailable',
  INVALID_INPUT: 'invalid_input',
  UNEXPECTED_RESPONSE: 'unexpected_response'
});

/* French is the source sentence; English its translation (i18n-server catalog). */
const SOURCES = {
  not_configured: "Le transporteur n'est pas encore configuré. Saisissez le colis à la main pour l'instant.",
  credentials_refused: 'Le transporteur a refusé les clés enregistrées. Vérifiez-les dans votre compte.',
  unavailable: 'Le transporteur est momentanément indisponible. Réessayez dans un instant, ou saisissez le colis à la main.',
  rejected: "Le transporteur a refusé cette demande. Vérifiez l'adresse de livraison, le poids et la méthode d'expédition.",
  not_found: "Le transporteur ne trouve pas l'étiquette de ce colis. Elle a peut-être été annulée.",
  cancel_refused: 'Le transporteur ne peut plus annuler cette étiquette : le colis est peut-être déjà pris en charge.',
  no_method: "Aucune méthode d'expédition n'est proposée pour cette destination et ce poids.",
  service_points_unavailable: 'Le choix du point relais est indisponible pour le moment.',
  invalid_input: 'Les informations du colis sont incomplètes ou invalides.',
  unexpected_response: 'Le transporteur a envoyé une réponse inattendue. Réessayez dans un instant.'
};
const ENGLISH = {
  not_configured: 'The carrier is not configured yet. Enter the parcel by hand for now.',
  credentials_refused: 'The carrier refused the saved keys. Check them in your account.',
  unavailable: 'The carrier is temporarily unavailable. Try again in a moment, or enter the parcel by hand.',
  rejected: 'The carrier refused this request. Check the delivery address, the weight and the shipping method.',
  not_found: 'The carrier cannot find the label of this parcel. It may have been cancelled.',
  cancel_refused: 'The carrier can no longer cancel this label: the parcel may already have been picked up.',
  no_method: 'No shipping method is offered for this destination and weight.',
  service_points_unavailable: 'Choosing a service point is unavailable for now.',
  invalid_input: 'The parcel details are incomplete or invalid.',
  unexpected_response: 'The carrier sent an unexpected answer. Try again in a moment.'
};

const catalog = createMessageCatalog({
  languages: ['fr', 'en'],
  defaultLanguage: 'fr',
  messages: Object.fromEntries(Object.keys(SOURCES).map((code) => [SOURCES[code], { en: ENGLISH[code] }]))
});

/** The sentence for a code (or a ShippingError) in 'fr' or 'en'; French when the language is unknown. */
function messageFor(codeOrError, language = 'fr') {
  const code = typeof codeOrError === 'string' ? codeOrError : codeOrError && codeOrError.code;
  const source = SOURCES[code] || SOURCES.unexpected_response;
  return catalog.translate(source, catalog.supports(language) ? language : 'fr');
}

/** HTTP status an application can answer with, per code. */
const STATUS = {
  not_configured: 503, credentials_refused: 502, unavailable: 503, rejected: 422, not_found: 404,
  cancel_refused: 409, no_method: 422, service_points_unavailable: 503, invalid_input: 422, unexpected_response: 502
};

class ShippingError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {{ providerStatus?: number, cause?: unknown }} [details] the provider's HTTP status, never its body
   */
  constructor(code, details = {}) {
    super(ENGLISH[code] || ENGLISH.unexpected_response);
    this.name = 'ShippingError';
    this.code = code;
    this.status = STATUS[code] || 502;
    if (details.providerStatus !== undefined) this.providerStatus = details.providerStatus;
  }
}

module.exports = { CODES, ShippingError, messageFor };
