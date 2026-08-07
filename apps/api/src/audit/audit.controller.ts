import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, type AuthenticatedPrincipal } from '../auth/access-token.guard';
import { AuditService } from './audit.service';

@ApiTags('activity')
@Controller('activity')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'Security activity for the signed-in account',
    description:
      'Records what happened — sign-ins, device changes, permission denials. Never file contents, messages or browsing history.',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.audit.listForUser(principal.userId, { limit, cursor });
  }
}
