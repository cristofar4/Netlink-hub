import '@testing-library/jest-dom/vitest';

// jsdom implements no media queries, and several components ask about
// prefers-reduced-motion on mount. Default to "no preference", which tests can
// override per case.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
