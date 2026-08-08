import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  approveFolderRequestSchema,
  fileOperationSchema,
  printJobRequestSchema,
  printJobResultSchema,
  startTransferRequestSchema,
  transferProgressSchema,
  type ApproveFolderRequest,
  type FileOperation,
  type PrintJobRequest,
  type PrintJobResult,
  type StartTransferRequest,
  type TransferProgress,
} from '@netlink/contracts';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { extractRequestContext } from '../common/request-context';
import { CurrentPrincipal, type AuthenticatedPrincipal } from '../auth/access-token.guard';
import { Public } from '../auth/public.decorator';
import {
  AgentSignatureGuard,
  CurrentAgent,
  type AgentPrincipal,
} from '../agents/agent-signature.guard';
import { FilesService } from './files.service';

@ApiTags('files')
@Controller('spaces/:spaceId/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('folders')
  @ApiOperation({
    summary: 'Approve a folder for sharing',
    description:
      'Owner only, and always explicit. NetLink never scans a drive to suggest folders — only what you name here becomes reachable.',
  })
  approveFolder(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body(new ZodValidationPipe(approveFolderRequestSchema)) body: ApproveFolderRequest,
    @Req() req: Request,
  ) {
    return this.files.approveFolder(principal.userId, spaceId, body, extractRequestContext(req));
  }

  @Get('folders')
  @ApiOperation({ summary: 'Folders shared in this Space' })
  listFolders(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.files.listFolders(principal.userId, spaceId);
  }

  @Post('transfers')
  @ApiOperation({
    summary: 'Start a file transfer',
    description:
      'Authorises the transfer and returns a ticket. The bytes travel directly between your devices — they never pass through, or rest on, this server.',
  })
  startTransfer(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body(new ZodValidationPipe(startTransferRequestSchema)) body: StartTransferRequest,
    @Req() req: Request,
  ) {
    return this.files.startTransfer(principal.userId, spaceId, body, extractRequestContext(req));
  }

  @Get('transfers')
  @ApiOperation({ summary: 'Recent transfers in this Space' })
  listTransfers(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('limit') limit?: string,
  ) {
    return this.files.listTransfers(principal.userId, spaceId, limit ? Number(limit) : undefined);
  }

  @Post('transfers/progress')
  @ApiOperation({ summary: 'Report transfer progress, or that it finished' })
  progress(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(transferProgressSchema)) body: TransferProgress,
  ) {
    return this.files.recordProgress({ userId: principal.userId }, body);
  }

  @Post('operations')
  @ApiOperation({
    summary: 'Create a folder, rename an item, or delete one',
    description:
      'Deleting needs its own permission and an explicit confirmation — being allowed to add a file is not the same as being allowed to destroy one.',
  })
  operation(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body(new ZodValidationPipe(fileOperationSchema)) body: FileOperation,
    @Req() req: Request,
  ) {
    return this.files.requestOperation(principal.userId, spaceId, body, extractRequestContext(req));
  }
}

@ApiTags('printers')
@Controller('spaces/:spaceId/printers')
export class PrintersController {
  constructor(private readonly files: FilesService) {}

  @Get()
  @ApiOperation({ summary: 'Printers shared in this Space' })
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.files.listPrinters(principal.userId, spaceId);
  }

  @Post('jobs')
  @ApiOperation({
    summary: 'Send a PDF to a shared printer',
    description:
      'Only PDFs are accepted, verified by their magic bytes rather than their name. The document is dropped the moment the agent collects it.',
  })
  submit(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body(new ZodValidationPipe(printJobRequestSchema)) body: PrintJobRequest,
    @Req() req: Request,
  ) {
    return this.files.submitPrintJob(principal.userId, spaceId, body, extractRequestContext(req));
  }

  @Get('jobs')
  @ApiOperation({ summary: 'Recent print jobs in this Space' })
  listJobs(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('limit') limit?: string,
  ) {
    return this.files.listPrintJobs(principal.userId, spaceId, limit ? Number(limit) : undefined);
  }
}

/** Agent-facing: collecting work and reporting what happened. */
@ApiTags('files')
@Controller('agent/work')
export class AgentWorkController {
  constructor(private readonly files: FilesService) {}

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post()
  @ApiOperation({
    summary: 'Collect transfers to serve and print jobs to run',
    description: 'A print job’s document is handed over once and cleared from the server.',
  })
  collect(@CurrentAgent() agent: AgentPrincipal) {
    return this.files.agentWork(agent);
  }

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('transfer-progress')
  @ApiOperation({ summary: 'Report transfer progress from the agent side' })
  transferProgress(
    @CurrentAgent() agent: AgentPrincipal,
    @Body(new ZodValidationPipe(transferProgressSchema)) body: TransferProgress,
  ) {
    return this.files.recordProgress({ agent }, body);
  }

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('print-result')
  @ApiOperation({ summary: 'Report the outcome of a print job' })
  printResult(
    @CurrentAgent() agent: AgentPrincipal,
    @Body(new ZodValidationPipe(printJobResultSchema)) body: PrintJobResult,
  ) {
    return this.files.recordPrintResult(agent, body);
  }
}
