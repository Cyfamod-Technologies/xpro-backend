import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { FileAccessService } from './file-access.service';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [UploadsController],
  providers: [UploadsService, FileAccessService],
  exports: [UploadsService, FileAccessService],
})
export class UploadsModule {}
