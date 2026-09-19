/**
 * A DOM for the render tests, installed BEFORE react-dom is loaded.
 *
 * react-native itself cannot run in Node (no native modules, Flow sources),
 * and the repo carries no react-native test preset. So the render tests mount
 * the kit with react-dom, in jsdom, over mocks of the react-native peers that
 * turn every host component into a DOM element carrying its props (test/rn.js).
 * What is checked is structure and behaviour — roles, states, labels, which
 * layer comes first, what a tap calls — never pixels.
 */
/* jsdom 30 pulls an ES-module-only dependency (@exodus/bytes) that jest's
   own module loader cannot require. Node 22+ can: jsdom is loaded through
   Node's native require, outside jest's registry (`process.getBuiltinModule`,
   because jest hands a test its own patched `module`). Nothing else needs to share
   its instance — react-dom only reads the globals installed below. */
const { createRequire } = process.getBuiltinModule('node:module');
const { JSDOM } = createRequire(`${__dirname}/`)('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://astratra-native-ui.test' });

// Node predefines some web globals as read-only getters: defineProperty
// sidesteps that for every entry, present or future (same as packages/react).
const defineGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

defineGlobal('window', dom.window);
defineGlobal('document', dom.window.document);
defineGlobal('navigator', dom.window.navigator);
defineGlobal('HTMLElement', dom.window.HTMLElement);
defineGlobal('Node', dom.window.Node);
defineGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
defineGlobal('requestAnimationFrame', (callback) => setTimeout(() => callback(Date.now()), 0));
defineGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

