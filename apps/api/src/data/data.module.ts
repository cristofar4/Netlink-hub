import { Module } from '@nestjs/common';
import { DataController, PassClaimController } from './data.controller';
import { DataService } from './data.service';
import { DemoDataProvider } from './providers/demo.provider';
import { DATA_PROVIDER } from './data.tokens';
import { TokenService } from '../crypto/token.service';

/**
 * The Data Pool.
 *
 * The adapter is bound here and nowhere else, so swapping the Demo Provider for
 * a real MTN, Airtel, fibre ISP or MVNO adapter is a one-line change in this
 * module rather than a change to any feature code.
 */
@Module({
  controllers: [DataController, PassClaimController],
  providers: [
    DataService,
    TokenService,
    DemoDataProvider,
    { provide: DATA_PROVIDER, useExisting: DemoDataProvider },
  ],
  exports: [DataService, DATA_PROVIDER],
})
export class DataModule {}
