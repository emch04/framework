/**
 * Côté client : connexion au serveur collaboratif et éditeur Tiptap branché
 * dessus. Aucune interface n'est imposée — l'application fournit l'élément
 * DOM, les extensions en plus et son propre habillage.
 */

const Y = require('yjs');
const { HocuspocusProvider } = require('@hocuspocus/provider');
const { Editor } = require('@tiptap/core');
const { Collaboration } = require('@tiptap/extension-collaboration');
const { defaultExtensions, DEFAULT_FIELD } = require('./convert');

/* 1009 : coupure par le serveur WebSocket lui-même (message au-delà de
   maxPayload). Les limites vérifiées par le serveur collaboratif se
   reconnaissent à leur raison : le code de fermeture n'arrive pas toujours
   intact jusqu'au client. */
const CODE_TROP_GROS = 1009;
const RAISONS_LIMITE = ['message-too-large', 'document-too-large'];

/**
 * Connexion à un document partagé.
 *
 * @param {object} options
 * @param {string} options.url        ws(s)://… du serveur collaboratif.
 * @param {string} options.name       nom du document (celui que voit `authenticate`).
 * @param {string|(() => string|Promise<string>)} [options.token] jeton de session.
 * @param {Y.Doc} [options.document]  document Yjs à partager (créé sinon).
 * @param {(scope: 'read-write'|'readonly') => void} [options.onAuthenticated]
 * @param {(reason: string) => void} [options.onDenied]
 * @param {(reason: string) => void} [options.onLimitExceeded] le serveur a coupé
 *        la connexion pour une limite de taille ; la reconnexion est arrêtée.
 */
function createCollabProvider({ url, name, token = '', document = new Y.Doc(), onAuthenticated, onDenied, onSynced, onLimitExceeded, onClose, ...reste } = {}) {
  if (!url) throw new TypeError('url est requis.');
  if (!name) throw new TypeError('name est requis.');
  let provider = null;
  let limiteSignalee = false;
  /* Un document trop gros le reste à la reconnexion : sans arrêt, le client
     renverrait le même contenu en boucle et se ferait couper à chaque fois.
     Ce rappel passe par la configuration du WebSocket, qui l'appelle AVANT
     de programmer la reconnexion : couper `shouldConnect` ici suffit. */
  const surFermeture = (donnees) => {
    const event = donnees?.event;
    if (event?.code === CODE_TROP_GROS || RAISONS_LIMITE.includes(event?.reason)) {
      if (provider?.manageSocket) provider.configuration.websocketProvider.disconnect();
      if (!limiteSignalee) {
        limiteSignalee = true;
        onLimitExceeded?.(event.reason || 'message-too-large');
      }
    }
    onClose?.(donnees);
  };
  provider = new HocuspocusProvider({
    ...reste,
    url,
    name,
    token,
    document,
    onClose: surFermeture,
    onAuthenticated: ({ scope }) => onAuthenticated?.(scope),
    onAuthenticationFailed: ({ reason }) => onDenied?.(reason),
    onSynced: ({ state }) => onSynced?.(state)
  });
  return provider;
}

/**
 * Éditeur Tiptap connecté. Passe soit un `provider` déjà créé, soit les
 * options de connexion (`url`, `name`, `token`).
 *
 * L'éditeur se met de lui-même en lecture seule quand le serveur n'accorde
 * que la lecture : une modification locale ne partirait nulle part.
 *
 * @returns {{ editor: Editor, provider: HocuspocusProvider, document: Y.Doc, destroy(): void }}
 */
function createCollabEditor({
  provider,
  url,
  name,
  token,
  element = null,
  extensions = defaultExtensions(),
  field = DEFAULT_FIELD,
  editable = true,
  editorOptions = {},
  onAuthenticated,
  onDenied,
  onSynced,
  onLimitExceeded
} = {}) {
  const possedeProvider = !provider;
  const fournisseur = provider || createCollabProvider({ url, name, token, onAuthenticated, onDenied, onSynced, onLimitExceeded });
  const document = fournisseur.document;

  const editor = new Editor({
    ...editorOptions,
    element,
    editable,
    extensions: [...extensions, Collaboration.configure({ document, field })]
  });

  const appliquerDroit = () => {
    if (fournisseur.authorizedScope === 'readonly') editor.setEditable(false);
  };
  appliquerDroit();
  fournisseur.on('authenticated', appliquerDroit);

  return {
    editor,
    provider: fournisseur,
    document,
    destroy() {
      fournisseur.off('authenticated', appliquerDroit);
      editor.destroy();
      // Un fournisseur passé par l'application lui appartient : on ne le ferme pas.
      if (possedeProvider) fournisseur.destroy();
    }
  };
}

module.exports = { createCollabProvider, createCollabEditor };
