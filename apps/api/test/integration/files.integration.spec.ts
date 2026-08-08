import request from 'supertest';
import type { Server } from 'node:http';
import {
  createTestHarness,
  makeDevice,
  readCode,
  strongPassword,
  type TestHarness,
} from '../harness';
import { TestAgent } from '../agent-client';

/** A minimal but genuinely valid PDF, base64 encoded. */
const PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').toString(
  'base64',
);
const NOT_A_PDF = Buffer.from('MZ\x90\x00 this is an executable').toString('base64');

describe('Files and printers (integration)', () => {
  let harness: TestHarness;
  let http: Server;

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  async function signIn(address: string) {
    const registration = await request(http)
      .post('/api/auth/register')
      .send({ name: address.split('@')[0], email: address, password: strongPassword })
      .expect(202);
    await request(http)
      .post('/api/auth/verify-email')
      .send({ challengeId: registration.body.challengeId, code: readCode(harness.mail, address) })
      .expect(200);

    const login = await request(http)
      .post('/api/auth/login')
      .send({ email: address, password: strongPassword, device: makeDevice() })
      .expect(200);

    const verified = await request(http)
      .post('/api/auth/verify-device')
      .send({
        challengeId: login.body.challenge.challengeId,
        code: readCode(harness.mail, address),
        trustDevice: true,
      })
      .expect(200);

    return {
      token: verified.body.tokens.accessToken as string,
      userId: verified.body.user.id as string,
    };
  }

  /** An owner with a Space, an online agent, an approved folder and a printer. */
  async function setup() {
    const owner = await signIn('owner@example.com');
    const spaces = await request(http)
      .get('/api/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    const spaceId = spaces.body[0].id as string;

    const tokenResponse = await request(http)
      .post(`/api/spaces/${spaceId}/enrollment-token`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(201);

    const agent = new TestAgent();
    const enrolled = await agent
      .post(http, '/agent/enroll', agent.enrollBody(tokenResponse.body.token, 'Home PC'))
      .expect(201);
    const deviceId = enrolled.body.deviceId as string;

    await agent.post(http, '/agent/heartbeat', agent.heartbeatBody(deviceId)).expect(201);

    const agentRow = await harness.prisma.agent.findFirstOrThrow({ where: { deviceId } });

    const folder = await request(http)
      .post(`/api/spaces/${spaceId}/files/folders`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        agentId: agentRow.id,
        name: 'Documents',
        path: 'C:\\Users\\Christopher\\Documents',
        readOnly: false,
      })
      .expect(201);

    await agent
      .post(http, '/agent/resources', {
        deviceId,
        resources: [
          {
            kind: 'printer',
            name: 'Office Laser',
            target: 'Office Laser',
            metadata: { status: 'ready', default: true },
          },
        ],
      })
      .expect(201);

    const resources = await request(http)
      .get(`/api/spaces/${spaceId}/resources?kind=printer`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);

    await request(http)
      .patch(`/api/spaces/${spaceId}/resources/${resources.body[0].id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ enabled: true })
      .expect(200);

    return {
      owner,
      spaceId,
      agent,
      deviceId,
      agentId: agentRow.id,
      folderId: folder.body.resourceId as string,
      printerId: resources.body[0].id as string,
    };
  }

  /** A member of the Space holding exactly `permissions`. */
  async function memberWith(spaceId: string, ownerToken: string, permissions: string[]) {
    const member = await signIn('member@example.com');

    const pass = await request(http)
      .post(`/api/spaces/${spaceId}/data/passes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        kind: 'custom',
        permissions,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(201);

    await request(http)
      .post('/api/passes/claim')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ token: pass.body.claimToken })
      .expect(201);

    return member;
  }

  // -------------------------------------------------------------------------
  // Approved folders
  // -------------------------------------------------------------------------

  describe('approved folders', () => {
    it('lists only what the owner approved', async () => {
      const { owner, spaceId } = await setup();

      const folders = await request(http)
        .get(`/api/spaces/${spaceId}/files/folders`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(folders.body).toHaveLength(1);
      expect(folders.body[0].name).toBe('Documents');
      expect(folders.body[0].agentOnline).toBe(true);
    });

    it('lets only the owner approve a folder', async () => {
      const { owner, spaceId, agentId } = await setup();
      const member = await memberWith(spaceId, owner.token, ['files.read', 'files.upload']);

      await request(http)
        .post(`/api/spaces/${spaceId}/files/folders`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ agentId, name: 'Everything', path: 'C:\\', readOnly: false })
        .expect(403);
    });

    it('refuses to approve a folder on a computer in another Space', async () => {
      const { agentId } = await setup();
      const stranger = await signIn('stranger@example.com');
      const theirSpaces = await request(http)
        .get('/api/spaces')
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(200);

      await request(http)
        .post(`/api/spaces/${theirSpaces.body[0].id}/files/folders`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .send({ agentId, name: 'Theirs', path: 'C:\\Users', readOnly: false })
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // Transfers
  // -------------------------------------------------------------------------

  describe('transfers', () => {
    it('starts a download and hands the agent the work', async () => {
      const { owner, spaceId, folderId, agent } = await setup();

      const transfer = await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: folderId, direction: 'download', path: 'report.pdf' })
        .expect(201);

      expect(transfer.body.state).toBe('pending');
      expect(transfer.body.path).toBe('report.pdf');

      const work = await agent.post(http, '/agent/work', {}).expect(201);
      expect(work.body.transfers).toHaveLength(1);
      expect(work.body.transfers[0].path).toBe('report.pdf');
      // The agent needs the real folder root; the client only ever saw an id.
      expect(work.body.transfers[0].rootPath).toBe('C:\\Users\\Christopher\\Documents');
    });

    it('resumes from an offset rather than starting over', async () => {
      const { owner, spaceId, folderId, agent } = await setup();

      await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          resourceId: folderId,
          direction: 'download',
          path: 'big.iso',
          offsetBytes: '1048576',
        })
        .expect(201);

      const work = await agent.post(http, '/agent/work', {}).expect(201);
      expect(work.body.transfers[0].offsetBytes).toBe('1048576');
    });

    it('records progress and a checksum on completion', async () => {
      const { owner, spaceId, folderId, agent, deviceId } = await setup();
      void deviceId;

      const transfer = await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: folderId, direction: 'download', path: 'report.pdf' })
        .expect(201);

      const checksum = 'a'.repeat(64);
      await agent
        .post(http, '/agent/work/transfer-progress', {
          transferId: transfer.body.id,
          transferredBytes: '2048',
          state: 'completed',
          checksum,
        })
        .expect(201);

      const stored = await harness.prisma.fileTransfer.findFirstOrThrow();
      expect(stored.state).toBe('completed');
      expect(stored.checksum).toBe(checksum);
      expect(stored.transferredBytes.toFixed(0)).toBe('2048');
    });

    it('never stores the file contents', async () => {
      const { owner, spaceId, folderId } = await setup();

      await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: folderId, direction: 'download', path: 'report.pdf' })
        .expect(201);

      // The columns that exist are metadata. There is nowhere for bytes to go.
      const stored = await harness.prisma.fileTransfer.findFirstOrThrow();
      expect(Object.keys(stored).sort()).toEqual(
        [
          'agentId',
          'checksum',
          'completedAt',
          'createdAt',
          'detail',
          'direction',
          'id',
          'path',
          'requestedById',
          'resourceId',
          'sizeBytes',
          'spaceId',
          'state',
          'transferredBytes',
          'updatedAt',
        ].sort(),
      );
    });

    it('refuses an upload to a read-only folder', async () => {
      const { owner, spaceId, agentId } = await setup();

      const readOnly = await request(http)
        .post(`/api/spaces/${spaceId}/files/folders`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ agentId, name: 'Archive', path: 'D:\\Archive', readOnly: true })
        .expect(201);

      await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: readOnly.body.resourceId, direction: 'upload', path: 'new.txt' })
        .expect(403);

      // ...but downloading from it still works.
      await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: readOnly.body.resourceId, direction: 'download', path: 'old.txt' })
        .expect(201);
    });

    it('refuses a transfer when the computer is offline', async () => {
      const { owner, spaceId, folderId, agentId } = await setup();

      await harness.prisma.agent.update({
        where: { id: agentId },
        data: { lastHeartbeatAt: new Date(Date.now() - 600_000) },
      });

      await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: folderId, direction: 'download', path: 'report.pdf' })
        .expect(409);
    });

    it('never hands one computer another computer’s transfer', async () => {
      const { owner, spaceId, folderId } = await setup();
      const stranger = new TestAgent();

      await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: folderId, direction: 'download', path: 'report.pdf' })
        .expect(201);

      // Not enrolled at all, so it is refused before it can see anything.
      await stranger.post(http, '/agent/work', {}).expect(401);
    });

    it('refuses progress from an unrelated agent', async () => {
      const { owner, spaceId, folderId, agent } = await setup();
      void agent;

      const transfer = await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: folderId, direction: 'download', path: 'report.pdf' })
        .expect(201);

      // A second, legitimately enrolled agent must not be able to touch it.
      const secondToken = await request(http)
        .post(`/api/spaces/${spaceId}/enrollment-token`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);
      const other = new TestAgent();
      await other
        .post(http, '/agent/enroll', other.enrollBody(secondToken.body.token, 'Other PC'))
        .expect(201);

      await other
        .post(http, '/agent/work/transfer-progress', {
          transferId: transfer.body.id,
          transferredBytes: '999',
          state: 'completed',
        })
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  describe('file operations', () => {
    it('refuses a delete without an explicit confirmation', async () => {
      const { owner, spaceId, folderId } = await setup();

      const response = await request(http)
        .post(`/api/spaces/${spaceId}/files/operations`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: folderId, operation: 'delete', path: 'old.txt', confirmed: false })
        .expect(400);

      expect(response.body.message).toMatch(/permanent/i);
    });

    it('accepts a confirmed delete', async () => {
      const { owner, spaceId, folderId } = await setup();

      await request(http)
        .post(`/api/spaces/${spaceId}/files/operations`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: folderId, operation: 'delete', path: 'old.txt', confirmed: true })
        .expect(201);

      const audit = await harness.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'file.deleted' },
      });
      expect((audit.metadata as { path: string }).path).toBe('old.txt');
    });

    it('needs a destination for a rename', async () => {
      const { owner, spaceId, folderId } = await setup();

      await request(http)
        .post(`/api/spaces/${spaceId}/files/operations`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: folderId, operation: 'rename', path: 'a.txt' })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  describe('permissions', () => {
    it('separates reading from uploading from deleting', async () => {
      const { owner, spaceId, folderId } = await setup();
      const reader = await memberWith(spaceId, owner.token, ['files.read']);

      // Can read...
      await request(http)
        .get(`/api/spaces/${spaceId}/files/folders`)
        .set('Authorization', `Bearer ${reader.token}`)
        .expect(200);
      await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${reader.token}`)
        .send({ resourceId: folderId, direction: 'download', path: 'report.pdf' })
        .expect(201);

      // ...but not write, and not delete.
      await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${reader.token}`)
        .send({ resourceId: folderId, direction: 'upload', path: 'new.txt' })
        .expect(403);
      await request(http)
        .post(`/api/spaces/${spaceId}/files/operations`)
        .set('Authorization', `Bearer ${reader.token}`)
        .send({ resourceId: folderId, operation: 'delete', path: 'x.txt', confirmed: true })
        .expect(403);
    });

    it('does not let uploading imply deleting', async () => {
      const { owner, spaceId, folderId } = await setup();
      const uploader = await memberWith(spaceId, owner.token, ['files.read', 'files.upload']);

      await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set('Authorization', `Bearer ${uploader.token}`)
        .send({ resourceId: folderId, direction: 'upload', path: 'new.txt' })
        .expect(201);

      // Being allowed to add a file is not being allowed to destroy one.
      await request(http)
        .post(`/api/spaces/${spaceId}/files/operations`)
        .set('Authorization', `Bearer ${uploader.token}`)
        .send({ resourceId: folderId, operation: 'delete', path: 'x.txt', confirmed: true })
        .expect(403);
    });

    it('refuses a Data-Only member every file and printer endpoint', async () => {
      const { owner, spaceId, folderId, printerId } = await setup();
      const dataOnly = await memberWith(spaceId, owner.token, ['data.use']);
      const auth = { Authorization: `Bearer ${dataOnly.token}` };

      await request(http).get(`/api/spaces/${spaceId}/files/folders`).set(auth).expect(403);
      await request(http).get(`/api/spaces/${spaceId}/printers`).set(auth).expect(403);
      await request(http)
        .post(`/api/spaces/${spaceId}/files/transfers`)
        .set(auth)
        .send({ resourceId: folderId, direction: 'download', path: 'anything' })
        .expect(403);
      await request(http)
        .post(`/api/spaces/${spaceId}/printers/jobs`)
        .set(auth)
        .send({
          resourceId: printerId,
          documentBase64: PDF_BASE64,
          documentName: 'x.pdf',
        })
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // Printing
  // -------------------------------------------------------------------------

  describe('printing', () => {
    it('lists shared printers with their status', async () => {
      const { owner, spaceId } = await setup();

      const printers = await request(http)
        .get(`/api/spaces/${spaceId}/printers`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(printers.body).toHaveLength(1);
      expect(printers.body[0].name).toBe('Office Laser');
      expect(printers.body[0].status).toBe('ready');
      expect(printers.body[0].isDefault).toBe(true);
      expect(printers.body[0].agentOnline).toBe(true);
    });

    it('accepts a PDF and queues it', async () => {
      const { owner, spaceId, printerId } = await setup();

      const job = await request(http)
        .post(`/api/spaces/${spaceId}/printers/jobs`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          resourceId: printerId,
          documentBase64: PDF_BASE64,
          documentName: 'invoice.pdf',
          copies: 2,
          colour: false,
          paperSize: 'A4',
        })
        .expect(201);

      expect(job.body.state).toBe('queued');
      expect(job.body.copies).toBe(2);
      expect(job.body.colour).toBe(false);
      expect(job.body.paperSize).toBe('A4');
      // The job summary must not carry the document back out.
      expect(JSON.stringify(job.body)).not.toContain(PDF_BASE64);
    });

    it('refuses anything that is not a PDF, whatever it is called', async () => {
      const { owner, spaceId, printerId } = await setup();

      const response = await request(http)
        .post(`/api/spaces/${spaceId}/printers/jobs`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          resourceId: printerId,
          documentBase64: NOT_A_PDF,
          // A convincing name proves nothing — the bytes are what is checked.
          documentName: 'totally-a-document.pdf',
        })
        .expect(400);

      expect(response.body.message).toMatch(/PDF/i);
    });

    it('drops the document as soon as the agent collects it', async () => {
      const { owner, spaceId, printerId, agent } = await setup();

      await request(http)
        .post(`/api/spaces/${spaceId}/printers/jobs`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: printerId, documentBase64: PDF_BASE64, documentName: 'invoice.pdf' })
        .expect(201);

      const beforeCollection = await harness.prisma.printJob.findFirstOrThrow();
      expect(beforeCollection.document).toBe(PDF_BASE64);

      const work = await agent.post(http, '/agent/work', {}).expect(201);
      expect(work.body.printJobs).toHaveLength(1);
      expect(work.body.printJobs[0].documentBase64).toBe(PDF_BASE64);

      // Printed content is content, and the control plane does not keep content.
      const afterCollection = await harness.prisma.printJob.findFirstOrThrow();
      expect(afterCollection.document).toBeNull();
      expect(afterCollection.state).toBe('sent');
    });

    it('records the outcome and audits it', async () => {
      const { owner, spaceId, printerId, agent, deviceId } = await setup();

      const job = await request(http)
        .post(`/api/spaces/${spaceId}/printers/jobs`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: printerId, documentBase64: PDF_BASE64, documentName: 'invoice.pdf' })
        .expect(201);

      await agent.post(http, '/agent/work', {}).expect(201);
      await agent
        .post(http, '/agent/work/print-result', {
          deviceId,
          jobId: job.body.id,
          state: 'completed',
          detail: 'Printed 1 page',
        })
        .expect(201);

      const stored = await harness.prisma.printJob.findFirstOrThrow();
      expect(stored.state).toBe('completed');

      const audit = await harness.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'printer.job.result' },
      });
      expect(audit.outcome).toBe('success');
      // The audit records what was printed, never what was in it.
      expect(JSON.stringify(audit.metadata)).not.toContain(PDF_BASE64);
    });

    it('records a failure honestly', async () => {
      const { owner, spaceId, printerId, agent, deviceId } = await setup();

      const job = await request(http)
        .post(`/api/spaces/${spaceId}/printers/jobs`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: printerId, documentBase64: PDF_BASE64, documentName: 'x.pdf' })
        .expect(201);

      await agent.post(http, '/agent/work', {});
      await agent
        .post(http, '/agent/work/print-result', {
          deviceId,
          jobId: job.body.id,
          state: 'failed',
          detail: 'Out of paper',
        })
        .expect(201);

      const audit = await harness.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'printer.job.result' },
      });
      expect(audit.outcome).toBe('failure');
    });

    it('refuses a job for a printer that is not shared', async () => {
      const { owner, spaceId, printerId } = await setup();

      await request(http)
        .patch(`/api/spaces/${spaceId}/resources/${printerId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ enabled: false })
        .expect(200);

      await request(http)
        .post(`/api/spaces/${spaceId}/printers/jobs`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: printerId, documentBase64: PDF_BASE64, documentName: 'x.pdf' })
        .expect(404);
    });

    it('refuses a job when the computer is offline', async () => {
      const { owner, spaceId, printerId, agentId } = await setup();

      await harness.prisma.agent.update({
        where: { id: agentId },
        data: { lastHeartbeatAt: new Date(Date.now() - 600_000) },
      });

      await request(http)
        .post(`/api/spaces/${spaceId}/printers/jobs`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: printerId, documentBase64: PDF_BASE64, documentName: 'x.pdf' })
        .expect(409);
    });

    it('caps the number of copies', async () => {
      const { owner, spaceId, printerId } = await setup();

      await request(http)
        .post(`/api/spaces/${spaceId}/printers/jobs`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          resourceId: printerId,
          documentBase64: PDF_BASE64,
          documentName: 'x.pdf',
          copies: 5000,
        })
        .expect(400);
    });

    it('refuses a result from an unrelated computer', async () => {
      const { owner, spaceId, printerId } = await setup();

      const job = await request(http)
        .post(`/api/spaces/${spaceId}/printers/jobs`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ resourceId: printerId, documentBase64: PDF_BASE64, documentName: 'x.pdf' })
        .expect(201);

      const secondToken = await request(http)
        .post(`/api/spaces/${spaceId}/enrollment-token`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);
      const other = new TestAgent();
      const enrolled = await other
        .post(http, '/agent/enroll', other.enrollBody(secondToken.body.token, 'Other PC'))
        .expect(201);

      await other
        .post(http, '/agent/work/print-result', {
          deviceId: enrolled.body.deviceId,
          jobId: job.body.id,
          state: 'completed',
        })
        .expect(403);
    });
  });
});
