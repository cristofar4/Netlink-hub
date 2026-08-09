import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, type AuthenticatedPrincipal } from '../auth/access-token.guard';
import { OverviewService } from './overview.service';

@ApiTags('spaces')
@Controller('spaces/:spaceId/overview')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  @ApiOperation({
    summary: 'Everything the Overview screen shows, in one consistent read',
    description:
      'Counts of computers, shared resources, members and live sessions, the Data Pool if the caller may manage it, and a health score with the checks behind it.',
  })
  forSpace(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.overview.forSpace(principal.userId, spaceId);
  }
}
