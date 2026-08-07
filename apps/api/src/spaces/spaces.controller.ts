import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createSpaceRequestSchema,
  renameSpaceRequestSchema,
  type CreateSpaceRequest,
} from '@netlink/contracts';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { extractRequestContext } from '../common/request-context';
import { CurrentPrincipal, type AuthenticatedPrincipal } from '../auth/access-token.guard';
import { SpacesService } from './spaces.service';

@ApiTags('spaces')
@Controller('spaces')
export class SpacesController {
  constructor(private readonly spaces: SpacesService) {}

  @Get()
  @ApiOperation({
    summary: 'Spaces this account can reach',
    description:
      'Creates the default "My Home" Space on first call, so a new account always lands somewhere.',
  })
  async list(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Req() req: Request) {
    await this.spaces.ensureDefaultSpace(principal.userId, extractRequestContext(req));
    return this.spaces.listForUser(principal.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a Space' })
  create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(createSpaceRequestSchema)) body: CreateSpaceRequest,
    @Req() req: Request,
  ) {
    return this.spaces.create(principal.userId, body.name, extractRequestContext(req));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a Space' })
  rename(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(renameSpaceRequestSchema)) body: CreateSpaceRequest,
    @Req() req: Request,
  ) {
    return this.spaces.rename(principal.userId, id, body.name, extractRequestContext(req));
  }
}
