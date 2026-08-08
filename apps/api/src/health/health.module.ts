import { Module } from '@nestjs/common';
import { HealthController, MetricsController } from './health.controller';

@Module({
  controllers: [HealthController, MetricsController],
})
export class HealthModule {}
