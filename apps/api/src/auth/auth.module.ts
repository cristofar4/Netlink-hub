import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ChallengeService } from './challenge.service';
import { SessionService } from './session.service';
import { AccessTokenGuard } from './access-token.guard';
import { PasswordService } from '../crypto/password.service';
import { TokenService } from '../crypto/token.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    ChallengeService,
    SessionService,
    PasswordService,
    TokenService,
    AccessTokenGuard,
  ],
  exports: [
    AuthService,
    SessionService,
    ChallengeService,
    PasswordService,
    TokenService,
    AccessTokenGuard,
  ],
})
export class AuthModule {}
