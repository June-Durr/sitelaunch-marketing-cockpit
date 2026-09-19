import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Recharts measures its container; jsdom reports zero, so give it a real box.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 300, configurable: true });

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});
