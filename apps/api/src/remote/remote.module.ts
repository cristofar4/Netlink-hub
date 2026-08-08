import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PowerModule } from '../power/power.module';
import { AgentRemoteController, RemoteController } from './remote.controller';
import { RemoteService } from './remote.service';
import { GrantSigner } from './grant-signer';
import { IceService } from './ice.service';

@Module({
  // PowerModule supplies the control plane's signing key, which grants share so
  // agents have one key to fetch, pin and rotate rather than two.
  imports: [AuthModule, PowerModule],
  controllers: [RemoteController, AgentRemoteController],
  providers: [RemoteService, GrantSigner, IceService],
  exports: [RemoteService, IceService],
})
export class RemoteModule {}
