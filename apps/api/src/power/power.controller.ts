import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import {
  POWER_ACTIONS,
  powerCommandRequestSchema,
  powerResultSchema,
  registerMacRequestSchema,
  setWakeHelperRequestSchema,
  type PowerAction,
  type PowerCommandRequest,
  type PowerResult,
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
import { PowerService } from './power.service';
import { CommandSigner } from './command-signer';

const stepUpSchema = z.object({ action: z.enum(POWER_ACTIONS) });

@ApiTags('power')
@Controller('spaces/:spaceId/power')
export class PowerController {
  constructor(
    private readonly power: PowerService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Power state of every computer in this Space',
    description:
      'Each action reports whether it can be attempted and, if not, exactly why — so a disabled button always has a reason a person can act on.',
  })
  state(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.power.spacePowerState(principal.userId, spaceId);
  }

  @Post('step-up')
  @ApiOperation({
    summary: 'Send a confirmation code before a restart or shutdown',
    description:
      'Holding the permission is not enough for an action that interrupts whoever is at the machine.',
  })
  stepUp(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body(new ZodValidationPipe(stepUpSchema)) body: { action: PowerAction },
  ) {
    return this.power.requestStepUp(
      principal.userId,
      spaceId,
      body.action,
      this.config.get('EXPOSE_DEV_OTP', { infer: true }),
    );
  }

  @Post('commands')
  @ApiOperation({
    summary: 'Request a power action',
    description:
      'Restart and shutdown enter a ten-second countdown that anyone can cancel, and are only handed to the agent once it elapses.',
  })
  request(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body(new ZodValidationPipe(powerCommandRequestSchema)) body: PowerCommandRequest,
    @Req() req: Request,
  ) {
    return this.power.requestCommand(
      principal.userId,
      principal.deviceId,
      spaceId,
      body,
      extractRequestContext(req),
    );
  }

  @Get('commands')
  @ApiOperation({ summary: 'Recent power actions in this Space' })
  history(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('limit') limit?: string,
  ) {
    return this.power.history(principal.userId, spaceId, limit ? Number(limit) : undefined);
  }

  @Put('agents/:agentId/wake-helper')
  @ApiOperation({
    summary: 'Choose whether this computer acts as a Wake Helper',
    description:
      'A Wake Helper stays online and sends the magic packet that wakes another computer on the same local network.',
  })
  setWakeHelper(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body(new ZodValidationPipe(setWakeHelperRequestSchema)) body: { isWakeHelper: boolean },
    @Req() req: Request,
  ) {
    return this.power.setWakeHelper(
      principal.userId,
      spaceId,
      agentId,
      body.isWakeHelper,
      extractRequestContext(req),
    );
  }

  @Put('agents/:agentId/mac')
  @ApiOperation({
    summary: 'Register the network address a wake will target',
    description:
      'Set by the owner rather than trusted from the agent — the machine being woken should not be able to redirect the packet.',
  })
  registerMac(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body(new ZodValidationPipe(registerMacRequestSchema)) body: { macAddress: string },
    @Req() req: Request,
  ) {
    return this.power.registerMac(
      principal.userId,
      spaceId,
      agentId,
      body.macAddress,
      extractRequestContext(req),
    );
  }
}

/** Agent-facing: collecting signed commands and reporting what happened. */
@ApiTags('power')
@Controller('agent/power')
export class AgentPowerController {
  constructor(
    private readonly power: PowerService,
    private readonly signer: CommandSigner,
  ) {}

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('collect')
  @ApiOperation({
    summary: 'Collect signed power commands for this computer',
    description:
      'A command in countdown is not handed over until the countdown elapses, so the agent genuinely cannot act early.',
  })
  collect(@CurrentAgent() agent: AgentPrincipal) {
    return this.power.collectFor(agent);
  }

  @Public()
  @UseGuards(AgentSignatureGuard)
  @Post('result')
  @ApiOperation({ summary: 'Report the outcome of a power command' })
  result(
    @CurrentAgent() agent: AgentPrincipal,
    @Body(new ZodValidationPipe(powerResultSchema)) body: PowerResult,
  ) {
    return this.power.recordResult(agent, body);
  }

  @Public()
  @Get('signing-key')
  @ApiOperation({
    summary: 'The public key power commands are signed with',
    description:
      'Public by design: it verifies signatures and cannot create them. Agents fetch it at enrollment and after a key rotation.',
  })
  signingKey() {
    return this.signer.publicKey();
  }
}
