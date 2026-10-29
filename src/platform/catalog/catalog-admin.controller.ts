import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequestUser } from '../../common/types/request-user';
import { CatalogQuestionService } from './catalog-question.service';
import { CatalogService } from './catalog.service';
import {
  CatalogSettingsDto,
  CreateQuestionDto,
  CreateServiceDto,
  ReorderQuestionsDto,
  ReorderServicesDto,
  UpdateQuestionDto,
  UpdateServiceDto,
} from './dto/catalog.dto';

@ApiTags('Admin catalog')
@ApiBearerAuth()
@Controller('admin/catalog')
@UseGuards(JwtAuthGuard)
export class CatalogAdminController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly questions: CatalogQuestionService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Read the full catalog with usage counts' })
  tree(@CurrentUser() user: RequestUser) {
    return this.catalog.adminCatalog(user.id);
  }

  @Post('services')
  @ApiOperation({ summary: 'Add a service or sub-service' })
  createService(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateServiceDto,
  ) {
    return this.catalog.createService(user.id, dto);
  }

  @Put('services/reorder')
  @ApiOperation({ summary: 'Reorder the services under one parent' })
  reorderServices(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderServicesDto,
  ) {
    return this.catalog.reorderServices(user.id, dto);
  }

  @Patch('services/:id')
  @ApiOperation({ summary: 'Edit a service' })
  updateService(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateServiceDto,
  ) {
    return this.catalog.updateService(user.id, id, dto);
  }

  @Delete('services/:id')
  @ApiOperation({ summary: 'Delete a service that has no requests' })
  deleteService(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.catalog.deleteService(user.id, id);
  }

  @Post('services/:id/questions')
  @ApiOperation({ summary: 'Add a question to a service' })
  createQuestion(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: CreateQuestionDto,
  ) {
    return this.questions.create(user.id, id, dto);
  }

  @Put('services/:id/questions/reorder')
  @ApiOperation({ summary: 'Reorder the questions of a service' })
  reorderQuestions(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ReorderQuestionsDto,
  ) {
    return this.questions.reorder(user.id, id, dto);
  }

  @Patch('questions/:id')
  @ApiOperation({ summary: 'Edit a question' })
  updateQuestion(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateQuestionDto,
  ) {
    return this.questions.update(user.id, id, dto);
  }

  @Delete('questions/:id')
  @ApiOperation({ summary: 'Delete a question' })
  deleteQuestion(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.questions.remove(user.id, id);
  }

  @Put('settings')
  @ApiOperation({ summary: 'Set the maximum service nesting depth' })
  saveSettings(
    @CurrentUser() user: RequestUser,
    @Body() dto: CatalogSettingsDto,
  ) {
    return this.catalog.saveSettings(user, dto);
  }
}
