import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Recharts measures its container; jsdom reports zero, so give it a real box.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 300, configurable: true });

// jsdom has no scrolling, so it has no scrollIntoView. The assistant panel
// keeps the newest turn in view with it, which is a real browser behaviour and
// nothing this suite can assert on, so it becomes a no-op here.
//
// On Element rather than HTMLElement, which is where the real DOM defines it.
// A no-op on HTMLElement would shadow the spy the jump bar tests install on
// Element, and those tests would stop seeing the calls they are about.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});
