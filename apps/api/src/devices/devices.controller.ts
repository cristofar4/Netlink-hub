import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { renameDeviceRequestSchema, type RenameDeviceRequest } from '@netlink/contracts';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { extractRequestContext } from '../common/request-context';
import { CurrentPrincipal, type AuthenticatedPrincipal } from '../auth/access-token.guard';
import { DevicesService } from './devices.service';

@ApiTags('devices')
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @ApiOperation({ summary: 'List the devices enrolled on this account' })
  list(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.devices.list(principal.userId, principal.deviceId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a device' })
  rename(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(renameDeviceRequestSchema)) body: RenameDeviceRequest,
    @Req() req: Request,
  ) {
    return this.devices.rename(principal.userId, id, body.name, extractRequestContext(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Revoke a device',
    description:
      'Ends every session held by that device and clears its trust. Other devices on the account are unaffected.',
  })
  revoke(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.devices.revoke(principal.userId, id, extractRequestContext(req));
  }
}
