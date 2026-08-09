import { Module } from '@nestjs/common';
import { SpacesModule } from '../spaces/spaces.module';
import { DataModule } from '../data/data.module';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

/**
 * The Overview screen's one endpoint.
 *
 * It sits in its own module rather than inside Spaces because it reads across
 * features — agents, resources, sessions and the Data Pool. Putting it in
 * SpacesService would have made the lowest-level module in the application
 * depend on one of the highest.
 */
@Module({
  imports: [SpacesModule, DataModule],
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class OverviewModule {}
