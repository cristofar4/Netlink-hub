import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentPowerController, PowerController } from './power.controller';
import { PowerService } from './power.service';
import { CommandSigner } from './command-signer';

@Module({
  imports: [AuthModule],
  controllers: [PowerController, AgentPowerController],
  providers: [PowerService, CommandSigner],
  exports: [PowerService, CommandSigner],
})
export class PowerModule {}
