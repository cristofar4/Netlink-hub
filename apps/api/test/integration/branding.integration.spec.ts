import request from 'supertest';
import type { Server } from 'node:http';

import { createTestHarness, type TestHarness } from '../harness';

/**
 * The branding endpoint.
 *
 * It exists so the name on the sign-in screen and the name signing the
 * verification emails come from one place. The test that matters is the one
 * proving it is reachable before anyone has signed in — a sign-in screen cannot
 * authenticate to find out what it is called.
 */
describe('Branding (integration)', () => {
  let harness: TestHarness;
  let http: Server;

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('is readable without a session', async () => {
    const response = await request(http).get('/api/branding').expect(200);
    expect(typeof response.body.name).toBe('string');
    expect(response.body.name.length).toBeGreaterThan(0);
  });

  it('omits the optional fields rather than returning empty strings', async () => {
    // The test environment sets no BRAND_URL or BRAND_SUPPORT_EMAIL, so the
    // client should be able to test for their absence rather than for ''.
    const response = await request(http).get('/api/branding').expect(200);
    expect(response.body).not.toHaveProperty('url');
    expect(response.body).not.toHaveProperty('supportEmail');
  });

  it('carries nothing beyond what already appears in an email footer', async () => {
    const response = await request(http).get('/api/branding').expect(200);
    // Public endpoint: assert the shape rather than trusting it stays small.
    expect(Object.keys(response.body).sort()).toEqual(['name']);
  });
});
