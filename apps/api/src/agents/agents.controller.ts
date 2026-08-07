import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  agentEnrollRequestSchema,
  agentHeartbeatRequestSchema,
  agentResourceReportSchema,
  type AgentEnrollRequest,
  type AgentHeartbeatRequest,
  type AgentResourceReport,
} from '@netlink/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { extractRequestContext } from '../common/request-context';
import { CurrentPrincipal, type AuthenticatedPrincipal } from '../auth/access-token.guard';
import { Public } from '../auth/public.decorator';
import {
  AgentSignatureGuard,
  AllowsUnenrolledAgent,
  CurrentAgent,
  type AgentPrincipal,
} from './agent-signature.guard';
import { AgentsService } from './agents.service';

const setEnabledSchema = z.object({ enabled: z.boolean() });

/**
 * Agent-facing endpoints.
 *
 * These are `@Public()` with respect to the bearer-token guard because an agent
 * holds no session — it authenticates by signing each request with its device
 * key, which `AgentSignatureGuard` verifies.
 */
@ApiTags('agents')
@Controller('agent')
export class AgentEndpointsController {
  constructor(private readonly agents: AgentsService) {}

  @Public()
  @UseGuards(AgentSignatureGuard)
  @AllowsUnenrolledAgent()
  @Post('enroll')
  @ApiOperation({
    summary: 'Enroll an agent installation into a Space',
    description:
      'Authenticated by an Ed25519 request signature plus a short-lived enrollment token issued by the desktop app. The owner’s password is never involved.',
  })
  enroll(
    @Body(new ZodValidationPipe(agentEnrollRequestSchema)) body: AgentEnrollRequest,
    @Req() req: Request,
  ) {
    return this.agents.enroll(body, extractRequestContext(req));
  }

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('heartbeat')
  @ApiOperation({ summary: 'Report that this computer is up' })
  heartbeat(
    @CurrentAgent() agent: AgentPrincipal,
    @Body(new ZodValidationPipe(agentHeartbeatRequestSchema)) body: AgentHeartbeatRequest,
  ) {
    return this.agents.heartbeat(agent, body);
  }

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('resources')
  @ApiOperation({
    summary: 'Report the folders and printers this computer could offer',
    description:
      'Reporting a resource does not share it. Everything arrives disabled until the owner turns it on.',
  })
  reportResources(
    @CurrentAgent() agent: AgentPrincipal,
    @Body(new ZodValidationPipe(agentResourceReportSchema)) body: AgentResourceReport,
  ) {
    return this.agents.reportResources(agent, body);
  }
}

@ApiTags('agents')
@Controller('spaces/:spaceId')
export class SpaceAgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post('enrollment-token')
  @ApiOperation({
    summary: 'Mint a short-lived token so the local agent can enroll',
    description: 'Owner only. The token is valid for five minutes and can be used once.',
  })
  createEnrollmentToken(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Req() req: Request,
  ) {
    return this.agents.createEnrollmentToken(principal.userId, spaceId, extractRequestContext(req));
  }

  @Get('agents')
  @ApiOperation({ summary: 'Computers in this Space' })
  listAgents(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.agents.listAgents(principal.userId, spaceId);
  }

  @Get('resources')
  @ApiOperation({ summary: 'Folders and printers registered in this Space' })
  listResources(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('kind') kind?: 'folder' | 'printer',
  ) {
    return this.agents.listResources(principal.userId, spaceId, kind);
  }

  @Patch('resources/:resourceId')
  @ApiOperation({
    summary: 'Share or stop sharing a resource',
    description: 'Owner only. This is the moment a folder or printer becomes reachable.',
  })
  setResourceEnabled(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Body(new ZodValidationPipe(setEnabledSchema)) body: { enabled: boolean },
    @Req() req: Request,
  ) {
    return this.agents.setResourceEnabled(
      principal.userId,
      spaceId,
      resourceId,
      body.enabled,
      extractRequestContext(req),
    );
  }
}
