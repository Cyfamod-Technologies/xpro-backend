import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailRendererService } from './email-renderer.service';
import { EmailService } from './email.service';

@Module({
  imports: [ConfigModule],
  providers: [EmailRendererService, EmailService],
  exports: [EmailRendererService, EmailService],
})
export class EmailModule {}
