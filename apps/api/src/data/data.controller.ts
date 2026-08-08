import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  claimPassRequestSchema,
  createPassRequestSchema,
  updateAllocationRequestSchema,
  type ClaimPassRequest,
  type CreatePassRequest,
  type UpdateAllocationRequest,
} from '@netlink/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { extractRequestContext } from '../common/request-context';
import { CurrentPrincipal, type AuthenticatedPrincipal } from '../auth/access-token.guard';
import { DataService } from './data.service';

const connectPoolSchema = z.object({
  accountRef: z.string().trim().min(4).max(64),
});
const pauseSchema = z.object({ paused: z.boolean() });

@ApiTags('data')
@Controller('spaces/:spaceId/data')
export class DataController {
  constructor(private readonly data: DataService) {}

  @Post('pool')
  @ApiOperation({
    summary: 'Connect this Space to a data provider account',
    description:
      'The account is verified through the provider adapter before anything is stored. The development Demo Provider moves no real data and is labelled as a demo.',
  })
  connectPool(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body(new ZodValidationPipe(connectPoolSchema)) body: { accountRef: string },
    @Req() req: Request,
  ) {
    return this.data.connectPool(
      principal.userId,
      spaceId,
      body.accountRef,
      extractRequestContext(req),
    );
  }

  @Get('pool')
  @ApiOperation({ summary: 'Balance, allocations and usage for this Space' })
  pool(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.data.poolSummary(principal.userId, spaceId);
  }

  @Get('mine')
  @ApiOperation({
    summary: 'Your own allocation',
    description:
      'A Data-Only member sees their allowance, usage, daily limit, expiry and connection status — and nothing else about the Space.',
  })
  mine(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.data.myAllocation(principal.userId, spaceId);
  }

  @Get('members')
  @ApiOperation({
    summary: 'Member Access: everyone in this Space and exactly what they can reach',
  })
  members(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.data.memberAccess(principal.userId, spaceId);
  }

  @Patch('members/:memberId/pause')
  @ApiOperation({ summary: 'Pause or resume a member’s data' })
  pause(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body(new ZodValidationPipe(pauseSchema)) body: { paused: boolean },
    @Req() req: Request,
  ) {
    return this.data.pauseAllocation(
      principal.userId,
      spaceId,
      memberId,
      body.paused,
      extractRequestContext(req),
    );
  }

  @Patch('members/:memberId/allocation')
  @ApiOperation({ summary: 'Change a member’s total, daily limit or expiry' })
  updateAllocation(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body(new ZodValidationPipe(updateAllocationRequestSchema)) body: UpdateAllocationRequest,
    @Req() req: Request,
  ) {
    return this.data.updateAllocation(
      principal.userId,
      spaceId,
      memberId,
      body,
      extractRequestContext(req),
    );
  }

  @Delete('members/:memberId')
  @ApiOperation({
    summary: 'Revoke a member’s access',
    description: 'Ends the allocation and clears every permission the member held.',
  })
  revokeAccess(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Req() req: Request,
  ) {
    return this.data.revokeAccess(principal.userId, spaceId, memberId, extractRequestContext(req));
  }

  @Post('passes')
  @ApiOperation({
    summary: 'Create a NetLink Pass',
    description:
      'A Data-Only pass is forced to exactly `data.use`, whatever the request asks for. The claim token is returned once and never stored in plaintext.',
  })
  createPass(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body(new ZodValidationPipe(createPassRequestSchema)) body: CreatePassRequest,
    @Req() req: Request,
  ) {
    return this.data.createPass(principal.userId, spaceId, body, extractRequestContext(req));
  }

  @Get('passes')
  @ApiOperation({ summary: 'Passes issued for this Space' })
  listPasses(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.data.listPasses(principal.userId, spaceId);
  }

  @Delete('passes/:passId')
  @ApiOperation({ summary: 'Revoke a Pass that has not been used' })
  revokePass(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('passId', ParseUUIDPipe) passId: string,
    @Req() req: Request,
  ) {
    return this.data.revokePass(principal.userId, spaceId, passId, extractRequestContext(req));
  }
}

/** Claiming happens outside any Space — the claimant is not a member yet. */
@ApiTags('data')
@Controller('passes')
export class PassClaimController {
  constructor(private readonly data: DataService) {}

  @Post('claim')
  @ApiOperation({
    summary: 'Accept a NetLink Pass with your own account',
    description:
      'The invitee always brings their own NetLink account. An owner never shares a password.',
  })
  claim(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(claimPassRequestSchema)) body: ClaimPassRequest,
    @Req() req: Request,
  ) {
    return this.data.claimPass(principal.userId, body.token, extractRequestContext(req));
  }
}
