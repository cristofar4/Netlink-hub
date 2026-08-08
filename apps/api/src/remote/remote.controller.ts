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
import { ConfigService } from '@nestjs/config';
import {
  REMOTE_END_REASONS,
  createRemoteSessionSchema,
  remoteConnectedSchema,
  remoteSignalSchema,
  remoteViolationSchema,
  type CreateRemoteSessionRequest,
  type RemoteSignalRequest,
} from '@netlink/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { extractRequestContext } from '../common/request-context';
import { CurrentPrincipal, type AuthenticatedPrincipal } from '../auth/access-token.guard';
import { Public } from '../auth/public.decorator';
import {
  AgentSignatureGuard,
  CurrentAgent,
  type AgentPrincipal,
} from '../agents/agent-signature.guard';
import type { AppConfig } from '../config/configuration';
import { RemoteService } from './remote.service';

const endSchema = z.object({ reason: z.enum(REMOTE_END_REASONS).default('viewer_left') });

/** Viewer-facing: asking for a session, negotiating, staying alive, hanging up. */
@ApiTags('remote')
@Controller('spaces/:spaceId/remote')
export class RemoteController {
  constructor(
    private readonly remote: RemoteService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('sessions')
  @ApiOperation({ summary: 'Remote sessions in this Space, most recent first' })
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('limit') limit?: string,
  ) {
    return this.remote.listSessions(principal.userId, spaceId, limit ? Number(limit) : undefined);
  }

  @Post('step-up')
  @ApiOperation({
    summary: 'Send a confirmation code before taking control',
    description:
      'Holding the permission is not enough to take over someone else’s keyboard, for the same reason it is not enough to shut their machine down.',
  })
  stepUp(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.remote.requestStepUp(
      principal.userId,
      spaceId,
      this.config.get('EXPOSE_DEV_OTP', { infer: true }),
    );
  }

  @Post('sessions')
  @ApiOperation({
    summary: 'Ask for a remote desktop session',
    description:
      'Returns ICE servers and a session whose mode is already sealed into a signed grant. TURN credentials in the response expire in minutes.',
  })
  create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body(new ZodValidationPipe(createRemoteSessionSchema)) body: CreateRemoteSessionRequest,
    @Req() req: Request,
  ) {
    return this.remote.createSession(
      principal.userId,
      principal.deviceId,
      spaceId,
      body,
      extractRequestContext(req),
    );
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'One session' })
  get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.remote.getSession(principal.userId, sessionId);
  }

  @Post('sessions/:sessionId/heartbeat')
  @ApiOperation({
    summary: 'Say the viewer is still there',
    description:
      'A session with no heartbeat is closed, so a closed laptop cannot leave a screen being shared to nobody.',
  })
  heartbeat(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.remote.heartbeat(principal.userId, sessionId);
  }

  @Post('sessions/:sessionId/signal')
  @ApiOperation({
    summary: 'Post one signalling message to the computer',
    description:
      'Offers, answers and ICE candidates. Bounded in size and deleted with the session.',
  })
  signal(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(remoteSignalSchema)) body: RemoteSignalRequest,
  ) {
    return this.remote.postSignal('viewer', sessionId, body, principal.userId);
  }

  @Get('sessions/:sessionId/signals')
  @ApiOperation({ summary: 'Collect signalling messages the computer has posted' })
  signals(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.remote.collectSignals('viewer', sessionId, principal.userId);
  }

  @Post('sessions/:sessionId/end')
  @ApiOperation({ summary: 'End a session' })
  end(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(endSchema)) body: { reason: 'viewer_left' },
    @Req() req: Request,
  ) {
    return this.remote.endSession(
      principal.userId,
      sessionId,
      body.reason,
      extractRequestContext(req),
    );
  }
}

/**
 * Agent-facing: collecting grants, negotiating from the host side, and
 * reporting what happened.
 *
 * Every route here is signed with the agent's own Ed25519 key, so a grant is
 * only ever handed to the machine it names.
 */
@ApiTags('remote')
@Controller('agent/remote')
export class AgentRemoteController {
  constructor(private readonly remote: RemoteService) {}

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('grants')
  @ApiOperation({
    summary: 'Collect signed session grants for this computer',
    description:
      'The grant carries the session mode inside its signature, which is what makes view-only enforceable on the host rather than merely displayed on the viewer.',
  })
  grants(@CurrentAgent() agent: AgentPrincipal) {
    return this.remote.pendingGrantsFor(agent);
  }

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('sessions/:sessionId/signal')
  @ApiOperation({ summary: 'Post one signalling message to the viewer' })
  signal(
    @CurrentAgent() agent: AgentPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(remoteSignalSchema)) body: RemoteSignalRequest,
  ) {
    return this.remote.postSignal('host', sessionId, body, agent.userId);
  }

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('sessions/:sessionId/signals')
  @ApiOperation({ summary: 'Collect signalling messages the viewer has posted' })
  signals(
    @CurrentAgent() agent: AgentPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.remote.collectSignals('host', sessionId, agent.userId);
  }

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('connected')
  @ApiOperation({
    summary: 'Report that the peer connection came up',
    description:
      'Carries the candidate types in use so the viewer can be told honestly whether its pixels are going direct or through a relay.',
  })
  connected(
    @CurrentAgent() agent: AgentPrincipal,
    @Body(new ZodValidationPipe(remoteConnectedSchema))
    body: {
      deviceId: string;
      sessionId: string;
      localCandidateType?: string;
      remoteCandidateType?: string;
    },
  ) {
    return this.remote.markConnected(
      agent,
      body.sessionId,
      body.localCandidateType,
      body.remoteCandidateType,
    );
  }

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('violation')
  @ApiOperation({
    summary: 'Report input refused on a view-only session',
    description:
      'The host already refused it. This records that someone is running a client we did not ship.',
  })
  violation(
    @CurrentAgent() agent: AgentPrincipal,
    @Body(new ZodValidationPipe(remoteViolationSchema))
    body: { deviceId: string; sessionId: string; kind: 'input_on_view_only'; count: number },
  ) {
    return this.remote.reportViolation(agent, body.sessionId, body.count);
  }
}
