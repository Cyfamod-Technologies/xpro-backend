import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequestUser } from '../common/types/request-user';
import { CreateUploadDto } from './dto/create-upload.dto';
import { FileAccessService } from './file-access.service';
import { UploadsService } from './uploads.service';

@ApiTags('Files')
@Controller()
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly files: FileAccessService,
  ) {}

  @Post('uploads')
  @ApiOperation({ summary: 'Create a presigned file upload' })
  create(@CurrentUser() actor: RequestUser, @Body() dto: CreateUploadDto) {
    return this.uploads.create(actor.id, dto);
  }

  @Post('uploads/:id/complete')
  @ApiOperation({ summary: 'Verify and complete a file upload' })
  complete(@CurrentUser() actor: RequestUser, @Param('id') id: string) {
    return this.uploads.complete(actor.id, id);
  }

  @Delete('uploads/:id')
  @ApiOperation({ summary: 'Discard an unattached file upload' })
  delete(@CurrentUser() actor: RequestUser, @Param('id') id: string) {
    return this.uploads.delete(actor.id, id);
  }

  @Get('files/:id')
  @ApiOperation({ summary: 'Get an authorized presigned file URL' })
  file(@CurrentUser() actor: RequestUser, @Param('id') id: string) {
    return this.files.getFileUrl(actor, id);
  }
}
