import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LiveGateway } from './live.gateway';

@Global()
@Module({
  imports: [AuthModule],
  providers: [LiveGateway],
  exports: [LiveGateway],
})
export class LiveModule {}
