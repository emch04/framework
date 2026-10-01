/**
 * Conversions entre un document Yjs et les formats lisibles : JSON Tiptap
 * (ProseMirror), Markdown, HTML et texte brut.
 *
 * Elles servent à tout ce qui se passe hors de l'éditeur : indexer un document
 * pour la recherche, l'exporter, l'afficher en lecture seule côté serveur, ou
 * créer un document collaboratif à partir d'un contenu existant. Aucune n'a
 * besoin d'un DOM : elles tournent telles quelles dans Node.
 *
 * Le schéma vient des extensions Tiptap : passe les mêmes extensions que
 * l'éditeur, sans quoi un nœud inconnu du schéma fait échouer la conversion.
 */

const Y = require('yjs');
const { getSchema } = require('@tiptap/core');
const { StarterKit } = require('@tiptap/starter-kit');
const { MarkdownManager } = require('@tiptap/markdown');
const { renderToHTMLString } = require('@tiptap/static-renderer/pm/html-string');
const { prosemirrorJSONToYDoc, yXmlFragmentToProseMirrorRootNode } = require('y-prosemirror');

const CHAMP_PAR_DEFAUT = 'default';

/**
 * Extensions de base : le kit de départ, sans l'historique local
 * (l'annulation passe par Yjs dès que le document est partagé).
 */
function defaultExtensions() {
  return [StarterKit.configure({ undoRedo: false })];
}

/**
 * @param {object} [options]
 * @param {Array} [options.extensions] extensions Tiptap (celles de l'éditeur).
 * @param {string} [options.field='default'] fragment Yjs qui porte le texte.
 */
function createConverter({ extensions = defaultExtensions(), field = CHAMP_PAR_DEFAUT } = {}) {
  const schema = getSchema(extensions);
  const markdown = new MarkdownManager({ extensions });

  function versNoeud(source) {
    if (source instanceof Y.Doc) return yXmlFragmentToProseMirrorRootNode(source.getXmlFragment(field), schema);
    if (source instanceof Uint8Array) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, source);
      return versNoeud(doc);
    }
    if (source && typeof source === 'object' && source.type) return schema.nodeFromJSON(source);
    throw new TypeError('Source attendue : Y.Doc, état Yjs (Uint8Array) ou JSON Tiptap.');
  }

  return {
    schema,
    field,
    /** Y.Doc ou état binaire → JSON Tiptap. */
    toJSON(source) {
      return versNoeud(source).toJSON();
    },
    /** JSON Tiptap → nouveau Y.Doc prêt à être partagé. */
    fromJSON(json) {
      return prosemirrorJSONToYDoc(schema, versNoeud(json).toJSON(), field);
    },
    toMarkdown(source) {
      return markdown.serialize(versNoeud(source).toJSON());
    },
    /** Markdown → JSON Tiptap (pour importer un contenu existant). */
    markdownToJSON(texte) {
      return markdown.parse(String(texte));
    },
    fromMarkdown(texte) {
      return prosemirrorJSONToYDoc(schema, markdown.parse(String(texte)), field);
    },
    /** HTML échappé : un texte saisi « <script> » ressort en entités. */
    toHTML(source) {
      return renderToHTMLString({ extensions, content: versNoeud(source) });
    },
    /** Texte brut, blocs séparés par une ligne vide : ce qu'on indexe pour la recherche. */
    toText(source) {
      const noeud = versNoeud(source);
      return noeud.textBetween(0, noeud.content.size, '\n\n', ' ');
    },
    /** État binaire complet d'un Y.Doc (ce que la persistance stocke). */
    encodeState(doc) {
      return Y.encodeStateAsUpdate(doc);
    }
  };
}

module.exports = { createConverter, defaultExtensions, DEFAULT_FIELD: CHAMP_PAR_DEFAUT };
