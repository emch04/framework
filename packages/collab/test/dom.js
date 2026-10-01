/**
 * DOM de test pour l'éditeur Tiptap, installé AVANT le chargement de Tiptap.
 *
 * jsdom 30 tire une dépendance en modules ES que le chargeur de jest ne sait
 * pas lire : il est chargé par le `require` natif de Node, hors du registre
 * de jest (même méthode que @astratra/native-ui).
 */
const { createRequire } = process.getBuiltinModule('node:module');
const { JSDOM } = createRequire(`${__dirname}/`)('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://astratra-collab.test' });
const { window } = dom;

const definir = (nom, valeur) => {
  Object.defineProperty(globalThis, nom, { value: valeur, configurable: true, writable: true });
};

definir('window', window);
definir('document', window.document);
definir('navigator', window.navigator);
for (const constructeur of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMParser']) definir(constructeur, window[constructeur]);
definir('getSelection', window.getSelection.bind(window));
definir('requestAnimationFrame', (rappel) => setTimeout(() => rappel(Date.now()), 0));
definir('cancelAnimationFrame', (id) => clearTimeout(id));

// jsdom ne calcule aucune mise en page : ProseMirror en a besoin pour faire défiler.
const rectangleVide = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = rectangleVide;
window.Element.prototype.getClientRects = () => [];

module.exports = { dom };
