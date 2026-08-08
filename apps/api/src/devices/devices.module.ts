import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RemoteModule } from '../remote/remote.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [AuthModule, RemoteModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
