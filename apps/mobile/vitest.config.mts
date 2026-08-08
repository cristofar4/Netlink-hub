import { defineConfig } from 'vitest/config';

/**
 * Tests for the parts of the mobile app that are not React Native.
 *
 * The crypto, the encoding and the API client's logic are all plain
 * TypeScript, and testing them in Node is both faster and more honest than
 * standing up a React Native test renderer to check a base64 encoder.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
