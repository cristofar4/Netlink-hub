import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  loginRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  resendCodeRequestSchema,
  verifyDeviceRequestSchema,
  verifyEmailRequestSchema,
  type LoginRequest,
  type RefreshRequest,
  type RegisterRequest,
  type ResendCodeRequest,
  type VerifyDeviceRequest,
  type VerifyEmailRequest,
} from '@netlink/contracts';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { extractRequestContext } from '../common/request-context';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { CurrentPrincipal, type AuthenticatedPrincipal } from './access-token.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Create an account and send a six-digit confirmation code',
    description:
      'Always returns a challenge, whether or not the address was already registered, so the endpoint cannot be used to discover which emails have NetLink accounts.',
  })
  @ApiResponse({ status: 202, description: 'A confirmation code was sent.' })
  @ApiResponse({ status: 429, description: 'Too many registrations from this network.' })
  register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
    @Req() req: Request,
  ) {
    return this.auth.register(body, extractRequestContext(req));
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm an account with the emailed six-digit code' })
  verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailRequestSchema)) body: VerifyEmailRequest,
    @Req() req: Request,
  ) {
    return this.auth.verifyEmail(body, extractRequestContext(req));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in with email and password from a specific device',
    description:
      'Returns a session only for a device already trusted on this account. Any other device receives a verification challenge first.',
  })
  login(@Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest, @Req() req: Request) {
    return this.auth.login(body, extractRequestContext(req));
  }

  @Public()
  @Post('verify-device')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete new-device verification and optionally trust the device' })
  verifyDevice(
    @Body(new ZodValidationPipe(verifyDeviceRequestSchema)) body: VerifyDeviceRequest,
    @Req() req: Request,
  ) {
    return this.auth.verifyDevice(body, extractRequestContext(req));
  }

  @Public()
  @Post('resend-code')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a new six-digit code for a pending challenge' })
  resend(
    @Body(new ZodValidationPipe(resendCodeRequestSchema)) body: ResendCodeRequest,
    @Req() req: Request,
  ) {
    return this.auth.resendCode(body.challengeId, extractRequestContext(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'Refresh tokens rotate on every use. Presenting an already-rotated token revokes the entire session lineage.',
  })
  refresh(
    @Body(new ZodValidationPipe(refreshRequestSchema)) body: RefreshRequest,
    @Req() req: Request,
  ) {
    return this.auth.refresh(body.refreshToken, extractRequestContext(req));
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'End the session held by this refresh token' })
  logout(
    @Body(new ZodValidationPipe(refreshRequestSchema)) body: RefreshRequest,
    @Req() req: Request,
  ) {
    return this.auth.logout(body.refreshToken, extractRequestContext(req));
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in account' })
  me(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.auth.currentUser(principal.userId);
  }
}
