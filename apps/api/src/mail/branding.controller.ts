import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BrandingResponse } from '@netlink/contracts';
import { Public } from '../auth/public.decorator';
import type { Branding } from './branding';
import { MAIL_BRANDING } from './mail.service';

@ApiTags('health')
@Controller('branding')
export class BrandingController {
  constructor(@Inject(MAIL_BRANDING) private readonly brand: Branding) {}

  /**
   * Who this installation says it is.
   *
   * Public, and deliberately so: it is read before anyone has signed in, by the
   * sign-in screen itself. Everything here already appears in the footer of
   * every email the server sends, so there is nothing to withhold.
   *
   * Serving it from the same configuration that signs the emails is the point —
   * the name on the screen and the name in the inbox cannot disagree, which is
   * the comparison a person makes when deciding whether a code is genuine.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'The name and contact details this installation runs under' })
  branding(): BrandingResponse {
    return {
      name: this.brand.name,
      ...(this.brand.url ? { url: this.brand.url } : {}),
      ...(this.brand.supportEmail ? { supportEmail: this.brand.supportEmail } : {}),
    };
  }
}
