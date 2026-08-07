import { Module } from '@nestjs/common';
import { AgentEndpointsController, SpaceAgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentSignatureGuard } from './agent-signature.guard';
import { TokenService } from '../crypto/token.service';

@Module({
  controllers: [AgentEndpointsController, SpaceAgentsController],
  providers: [AgentsService, AgentSignatureGuard, TokenService],
  exports: [AgentsService],
})
export class AgentsModule {}
