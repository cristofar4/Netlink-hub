import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { json } from 'express';
import type { IncomingMessage } from 'node:http';
import type { DeviceIdentity } from '@netlink/contracts';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { MAIL_TRANSPORT, MemoryMailTransport } from '../src/mail/mail.service';
import { DemoDataProvider } from '../src/data/providers/demo.provider';

/**
 * Integration tests run against a real PostgreSQL database and a real Nest
 * application — no mocked repositories. The point of these tests is to prove
 * the guards and the SQL behave, and a mock proves neither.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://netlink:netlink@localhost:5432/netlink_test?schema=public';

export type TestHarness = {
  app: INestApplication;
  prisma: PrismaService;
  mail: MemoryMailTransport;
  close: () => Promise<void>;
  reset: () => Promise<void>;
};

let schemaPrepared = false;

export function prepareTestSchema(): void {
  if (schemaPrepared) return;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: `${__dirname}/..`,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
  schemaPrepared = true;
}

export async function createTestHarness(): Promise<TestHarness> {
  prepareTestSchema();

  // The environment itself is set in `test/setup-env.ts`, which Jest loads
  // before any import — see the note there.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication({ bodyParser: false });

  // The same wiring as production, so the tests exercise the real request
  // path: raw bodies captured for signature verification, and the native ws
  // adapter rather than the socket.io default.
  app.use(
    json({
      limit: '1mb',
      verify: (req: IncomingMessage & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api');
  await app.init();

  const prisma = app.get(PrismaService);
  const mail = app.get<MemoryMailTransport>(MAIL_TRANSPORT);

  const reset = async () => {
    // Truncate rather than drop: far faster between tests, and it resets the
    // identity sequences too.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE audit_events, refresh_tokens, challenges, request_nonces, agent_enrollment_tokens, resources, data_usage_events, data_allocations, data_pools, agents, space_members, invitations, spaces, devices, users RESTART IDENTITY CASCADE',
    );
    mail.clear();
    // The demo provider keeps allocations and usage in memory, so it has to be
    // reset alongside the database or usage would leak between tests.
    app.get(DemoDataProvider).reset();
  };

  await reset();

  return {
    app,
    prisma,
    mail,
    reset,
    close: async () => {
      await app.close();
    },
  };
}

/** A fresh, plausible device identity. Each call is a different "installation". */
export function makeDevice(overrides: Partial<DeviceIdentity> = {}): DeviceIdentity {
  return {
    installationId: randomUUID(),
    // Stand-in for the base64url Ed25519 public key the Go agent generates:
    // 32 bytes, which is 43 base64url characters.
    publicKey: randomBytes(32).toString('base64url'),
    publicKeyAlgorithm: 'ed25519',
    name: 'Test PC',
    platform: 'windows',
    kind: 'desktop',
    appVersion: '0.1.0',
    ...overrides,
  };
}

/** Reads the six-digit code out of the in-memory mailbox. */
export function readCode(mail: MemoryMailTransport, email: string): string {
  const message = mail.lastFor(email);
  if (!message) throw new Error(`No message was sent to ${email}`);
  const match = message.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`No six-digit code found in the message to ${email}`);
  return match[1];
}

export const strongPassword = 'CorrectHorse1Battery';
