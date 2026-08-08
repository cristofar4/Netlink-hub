import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  looksLikePdf,
  statusFromHeartbeat,
  type ApprovedFolder,
  type FileOperation,
  type PrintJob,
  type PrintJobRequest,
  type PrintJobResult,
  type SharedPrinter,
  type StartTransferRequest,
  type Transfer,
  type TransferProgress,
} from '@netlink/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SpacesService } from '../spaces/spaces.service';
import type { RequestContext } from '../common/request-context';
import type { AgentPrincipal } from '../agents/agent-signature.guard';

/**
 * Files and printers.
 *
 * The control plane authorises, brokers and records. It deliberately does not
 * carry file bytes: a transfer here is a ticket both ends present to each
 * other, and the data moves between the owner's own devices.
 *
 * The one exception is a print job, whose PDF is held briefly so the agent can
 * collect it — and dropped the instant it does.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly spaces: SpacesService,
  ) {}

  // -------------------------------------------------------------------------
  // Approved folders
  // -------------------------------------------------------------------------

  /**
   * Approves a folder for sharing.
   *
   * Owner only, and always explicit. NetLink never suggests folders by scanning
   * a drive — an owner names what they want to share, and nothing else becomes
   * reachable.
   */
  async approveFolder(
    userId: string,
    spaceId: string,
    input: { agentId: string; name: string; path: string; readOnly: boolean },
    context: RequestContext,
  ): Promise<ApprovedFolder> {
    await this.spaces.requireOwner(userId, spaceId, context);

    const agent = await this.prisma.agent.findUnique({
      where: { id: input.agentId },
      include: { device: { select: { name: true, revokedAt: true } } },
    });
    if (!agent || agent.spaceId !== spaceId || agent.device.revokedAt) {
      throw new NotFoundException('That computer was not found in this Space.');
    }

    const resource = await this.prisma.resource.upsert({
      where: {
        agentId_kind_target: { agentId: agent.id, kind: 'folder', target: input.path },
      },
      create: {
        spaceId,
        agentId: agent.id,
        kind: 'folder',
        name: input.name,
        target: input.path,
        enabled: true,
        metadata: { readOnly: input.readOnly },
      },
      update: { name: input.name, enabled: true, metadata: { readOnly: input.readOnly } },
    });

    await this.audit.record({
      action: 'resource.enabled',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
      metadata: { kind: 'folder', name: input.name, readOnly: input.readOnly },
    });

    return {
      resourceId: resource.id,
      agentId: agent.id,
      agentName: agent.device.name,
      name: resource.name,
      target: resource.target,
      readOnly: input.readOnly,
      agentOnline: statusFromHeartbeat(agent.lastHeartbeatAt) === 'online',
    };
  }

  async listFolders(userId: string, spaceId: string): Promise<ApprovedFolder[]> {
    await this.spaces.requirePermission(userId, spaceId, 'files.read');

    const resources = await this.prisma.resource.findMany({
      where: { spaceId, kind: 'folder', enabled: true },
      include: { agent: { include: { device: { select: { name: true, revokedAt: true } } } } },
      orderBy: { name: 'asc' },
    });

    return resources
      .filter((resource) => !resource.agent.device.revokedAt)
      .map((resource) => ({
        resourceId: resource.id,
        agentId: resource.agentId,
        agentName: resource.agent.device.name,
        name: resource.name,
        target: resource.target,
        readOnly: Boolean((resource.metadata as { readOnly?: boolean } | null)?.readOnly),
        agentOnline: statusFromHeartbeat(resource.agent.lastHeartbeatAt) === 'online',
      }));
  }

  // -------------------------------------------------------------------------
  // Transfers
  // -------------------------------------------------------------------------

  /**
   * Authorises a transfer and returns the ticket both ends use.
   *
   * Direction decides the capability: reading needs `files.read`, writing needs
   * `files.upload`. They are separate permissions because letting someone put
   * files onto your computer is a different decision from letting them read
   * what is already there.
   */
  async startTransfer(
    userId: string,
    spaceId: string,
    input: StartTransferRequest,
    context: RequestContext,
  ): Promise<Transfer> {
    const permission = input.direction === 'download' ? 'files.read' : 'files.upload';
    await this.spaces.requirePermission(userId, spaceId, permission, context);

    const resource = await this.requireFolder(spaceId, input.resourceId);

    if (input.direction === 'upload' && isReadOnly(resource.metadata)) {
      throw new ForbiddenException('That folder is shared read-only.');
    }

    if (statusFromHeartbeat(resource.agent.lastHeartbeatAt) !== 'online') {
      throw new ConflictException('That computer is not online.');
    }

    const transfer = await this.prisma.fileTransfer.create({
      data: {
        spaceId,
        resourceId: resource.id,
        agentId: resource.agentId,
        requestedById: userId,
        direction: input.direction,
        path: input.path,
        state: 'pending',
        sizeBytes: input.sizeBytes ?? null,
        transferredBytes: input.offsetBytes,
      },
    });

    await this.audit.record({
      action: input.direction === 'download' ? 'file.downloaded' : 'file.uploaded',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
      // The path is recorded so an owner can see what moved. The contents are
      // not here and never were.
      metadata: { path: input.path, direction: input.direction, resumedFrom: input.offsetBytes },
    });

    return toTransfer(transfer);
  }

  /** Updates progress. Called by whichever end is doing the work. */
  async recordProgress(
    principal: { userId?: string; agent?: AgentPrincipal },
    input: TransferProgress,
  ): Promise<Transfer> {
    const transfer = await this.prisma.fileTransfer.findUnique({
      where: { id: input.transferId },
    });
    if (!transfer) throw new NotFoundException('That transfer was not found.');

    if (principal.agent) {
      const agent = await this.prisma.agent.findUnique({
        where: { deviceId: principal.agent.deviceId },
      });
      if (!agent || agent.id !== transfer.agentId) {
        throw new ForbiddenException('That transfer does not belong to this computer.');
      }
    } else if (principal.userId && transfer.requestedById !== principal.userId) {
      throw new ForbiddenException('That transfer was not started by you.');
    }

    const updated = await this.prisma.fileTransfer.update({
      where: { id: transfer.id },
      data: {
        transferredBytes: input.transferredBytes,
        state: input.state,
        checksum: input.checksum ?? transfer.checksum,
        detail: input.detail ?? transfer.detail,
        completedAt:
          input.state === 'completed' || input.state === 'failed' || input.state === 'cancelled'
            ? new Date()
            : null,
      },
    });

    return toTransfer(updated);
  }

  async listTransfers(userId: string, spaceId: string, limit = 25): Promise<Transfer[]> {
    await this.spaces.requirePermission(userId, spaceId, 'files.read');

    const transfers = await this.prisma.fileTransfer.findMany({
      where: { spaceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return transfers.map(toTransfer);
  }

  /** Work waiting for an agent: transfers to serve, and print jobs to run. */
  async agentWork(principal: AgentPrincipal) {
    const agent = await this.prisma.agent.findUnique({ where: { deviceId: principal.deviceId } });
    if (!agent) return { transfers: [], printJobs: [] };

    const transfers = await this.prisma.fileTransfer.findMany({
      where: { agentId: agent.id, state: 'pending' },
      include: { resource: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    if (transfers.length > 0) {
      await this.prisma.fileTransfer.updateMany({
        where: { id: { in: transfers.map((t) => t.id) } },
        data: { state: 'active' },
      });
    }

    const printJobs = await this.prisma.printJob.findMany({
      where: { agentId: agent.id, state: 'queued' },
      include: { resource: true },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });

    if (printJobs.length > 0) {
      // The document is dropped the moment it is handed over. Keeping printed
      // content on the server afterwards would be storing content, which is
      // exactly what the control plane must not do.
      await this.prisma.printJob.updateMany({
        where: { id: { in: printJobs.map((j) => j.id) } },
        data: { state: 'sent', collectedAt: new Date(), document: null },
      });
    }

    return {
      transfers: transfers.map((transfer) => ({
        id: transfer.id,
        direction: transfer.direction,
        // The agent needs the real folder to serve from; the client never sees
        // this, only the resource id.
        rootPath: transfer.resource.target,
        resourceId: transfer.resourceId,
        readOnly: isReadOnly(transfer.resource.metadata),
        path: transfer.path,
        offsetBytes: transfer.transferredBytes.toFixed(0),
      })),
      printJobs: printJobs.map((job) => ({
        id: job.id,
        printerName: job.printerName,
        documentName: job.documentName,
        documentBase64: job.document,
        copies: job.copies,
        colour: job.colour,
        paperSize: job.paperSize,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  async requestOperation(
    userId: string,
    spaceId: string,
    input: FileOperation,
    context: RequestContext,
  ): Promise<{ accepted: true }> {
    // Deleting is a separate capability from uploading, on purpose: being
    // allowed to add a file is not the same as being allowed to destroy one.
    const permission = input.operation === 'delete' ? 'files.delete' : 'files.upload';
    await this.spaces.requirePermission(userId, spaceId, permission, context);

    if (input.operation === 'delete' && !input.confirmed) {
      throw new BadRequestException('Deleting is permanent. Confirm the deletion to go ahead.');
    }
    if (input.operation === 'rename' && !input.toPath) {
      throw new BadRequestException('A rename needs a destination.');
    }

    const resource = await this.requireFolder(spaceId, input.resourceId);
    if (isReadOnly(resource.metadata)) {
      throw new ForbiddenException('That folder is shared read-only.');
    }
    if (statusFromHeartbeat(resource.agent.lastHeartbeatAt) !== 'online') {
      throw new ConflictException('That computer is not online.');
    }

    await this.audit.record({
      action: input.operation === 'delete' ? 'file.deleted' : 'file.uploaded',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
      metadata: { operation: input.operation, path: input.path, toPath: input.toPath ?? null },
    });

    return { accepted: true };
  }

  // -------------------------------------------------------------------------
  // Printing
  // -------------------------------------------------------------------------

  async listPrinters(userId: string, spaceId: string): Promise<SharedPrinter[]> {
    await this.spaces.requirePermission(userId, spaceId, 'printers.use');

    const resources = await this.prisma.resource.findMany({
      where: { spaceId, kind: 'printer', enabled: true },
      include: { agent: { include: { device: { select: { name: true, revokedAt: true } } } } },
      orderBy: { name: 'asc' },
    });

    return resources
      .filter((resource) => !resource.agent.device.revokedAt)
      .map((resource) => {
        const metadata = (resource.metadata ?? {}) as { status?: string; default?: boolean };
        return {
          resourceId: resource.id,
          agentId: resource.agentId,
          agentName: resource.agent.device.name,
          name: resource.name,
          status: metadata.status ?? 'unknown',
          isDefault: Boolean(metadata.default),
          agentOnline: statusFromHeartbeat(resource.agent.lastHeartbeatAt) === 'online',
        };
      });
  }

  async submitPrintJob(
    userId: string,
    spaceId: string,
    input: PrintJobRequest,
    context: RequestContext,
  ): Promise<PrintJob> {
    await this.spaces.requirePermission(userId, spaceId, 'printers.use', context);

    // Checked by magic bytes rather than by file name: a name proves nothing,
    // and this endpoint must not become a way to push arbitrary files to a
    // machine under the guise of printing.
    if (!looksLikePdf(input.documentBase64)) {
      throw new BadRequestException('Only PDF documents can be printed.');
    }

    const resource = await this.prisma.resource.findUnique({
      where: { id: input.resourceId },
      include: { agent: { include: { device: { select: { revokedAt: true } } } } },
    });
    if (
      !resource ||
      resource.spaceId !== spaceId ||
      resource.kind !== 'printer' ||
      !resource.enabled ||
      resource.agent.device.revokedAt
    ) {
      throw new NotFoundException('That printer was not found in this Space.');
    }
    if (statusFromHeartbeat(resource.agent.lastHeartbeatAt) !== 'online') {
      throw new ConflictException('The computer that printer is attached to is not online.');
    }

    const job = await this.prisma.printJob.create({
      data: {
        spaceId,
        resourceId: resource.id,
        agentId: resource.agentId,
        requestedById: userId,
        printerName: resource.target,
        documentName: input.documentName,
        document: input.documentBase64,
        copies: input.copies,
        colour: input.colour,
        paperSize: input.paperSize,
        state: 'queued',
      },
    });

    await this.audit.record({
      action: 'printer.job.submitted',
      outcome: 'success',
      actorUserId: userId,
      spaceId,
      context,
      // The document name and settings, never the document.
      metadata: {
        printer: resource.name,
        documentName: input.documentName,
        copies: input.copies,
        colour: input.colour,
        paperSize: input.paperSize,
      },
    });

    return toPrintJob(job);
  }

  async recordPrintResult(
    principal: AgentPrincipal,
    input: PrintJobResult,
  ): Promise<{ recorded: true }> {
    if (input.deviceId !== principal.deviceId) {
      throw new BadRequestException('This result does not match the signing device.');
    }

    const job = await this.prisma.printJob.findUnique({ where: { id: input.jobId } });
    if (!job) throw new NotFoundException('That print job was not found.');

    const agent = await this.prisma.agent.findUnique({ where: { deviceId: principal.deviceId } });
    if (!agent || agent.id !== job.agentId) {
      throw new ForbiddenException('That print job was not sent to this computer.');
    }

    await this.prisma.printJob.update({
      where: { id: job.id },
      data: {
        state: input.state,
        detail: input.detail ?? null,
        // Belt and braces: the document was already cleared at collection.
        document: null,
        completedAt: input.state === 'completed' || input.state === 'failed' ? new Date() : null,
      },
    });

    await this.audit.record({
      action: 'printer.job.result',
      outcome: input.state === 'failed' ? 'failure' : 'success',
      spaceId: job.spaceId,
      actorUserId: job.requestedById,
      metadata: { printer: job.printerName, state: input.state, detail: input.detail ?? null },
    });

    return { recorded: true };
  }

  async listPrintJobs(userId: string, spaceId: string, limit = 25): Promise<PrintJob[]> {
    await this.spaces.requirePermission(userId, spaceId, 'printers.use');

    const jobs = await this.prisma.printJob.findMany({
      where: { spaceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return jobs.map(toPrintJob);
  }

  private async requireFolder(spaceId: string, resourceId: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id: resourceId },
      include: { agent: { include: { device: { select: { revokedAt: true } } } } },
    });

    if (
      !resource ||
      resource.spaceId !== spaceId ||
      resource.kind !== 'folder' ||
      !resource.enabled ||
      resource.agent.device.revokedAt
    ) {
      throw new NotFoundException('That folder is not shared in this Space.');
    }
    return resource;
  }
}

function isReadOnly(metadata: unknown): boolean {
  return Boolean((metadata as { readOnly?: boolean } | null)?.readOnly);
}

type TransferRow = {
  id: string;
  spaceId: string;
  resourceId: string;
  agentId: string;
  direction: string;
  path: string;
  state: string;
  sizeBytes: { toFixed(d: number): string } | null;
  transferredBytes: { toFixed(d: number): string };
  checksum: string | null;
  createdAt: Date;
  completedAt: Date | null;
  detail: string | null;
};

function toTransfer(transfer: TransferRow): Transfer {
  return {
    id: transfer.id,
    spaceId: transfer.spaceId,
    resourceId: transfer.resourceId,
    agentId: transfer.agentId,
    direction: transfer.direction as Transfer['direction'],
    path: transfer.path,
    state: transfer.state as Transfer['state'],
    sizeBytes: transfer.sizeBytes ? transfer.sizeBytes.toFixed(0) : null,
    transferredBytes: transfer.transferredBytes.toFixed(0),
    checksum: transfer.checksum,
    createdAt: transfer.createdAt.toISOString(),
    completedAt: transfer.completedAt ? transfer.completedAt.toISOString() : null,
    detail: transfer.detail,
  };
}

type PrintJobRow = {
  id: string;
  spaceId: string;
  printerName: string;
  documentName: string;
  copies: number;
  colour: boolean;
  paperSize: string;
  state: string;
  createdAt: Date;
  completedAt: Date | null;
  detail: string | null;
};

function toPrintJob(job: PrintJobRow): PrintJob {
  return {
    id: job.id,
    spaceId: job.spaceId,
    printerName: job.printerName,
    documentName: job.documentName,
    copies: job.copies,
    colour: job.colour,
    paperSize: job.paperSize as PrintJob['paperSize'],
    state: job.state as PrintJob['state'],
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    detail: job.detail,
  };
}
