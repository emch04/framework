import { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://astratra-react.test' });

// Node predefines some web globals (e.g. `navigator`) as read-only getters, and adds
// more of them over Node versions — a plain `globalThis.x = ...` throws the day Node
// starts predefining `x` too. `defineProperty` sidesteps that for every entry, present
// or future.
const defineGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

defineGlobal('window', dom.window);
defineGlobal('document', dom.window.document);
defineGlobal('navigator', dom.window.navigator);
defineGlobal('HTMLElement', dom.window.HTMLElement);
defineGlobal('customElements', dom.window.customElements);
defineGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
defineGlobal('requestAnimationFrame', (callback) => setTimeout(() => callback(Date.now()), 0));
defineGlobal('cancelAnimationFrame', (id) => clearTimeout(id));

// @testing-library/react auto-registers its cleanup in the host test framework's
// afterEach hook if it finds one on globalThis — node:test doesn't expose one globally.
globalThis.afterEach = afterEach;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
