import { Module } from '@nestjs/common';
import { AgentWorkController, FilesController, PrintersController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  controllers: [FilesController, PrintersController, AgentWorkController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
