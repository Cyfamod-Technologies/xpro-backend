import { Injectable } from '@nestjs/common';
import { RequestUser } from '../common/types/request-user';
import { ActorService } from '../platform/actor/actor.service';
import { SettingsService } from '../platform/settings/settings.service';
import {
  SavePlatformSettingsDto,
  PlatformSettingsHistoryQueryDto,
} from './dto/platform-settings.dto';

@Injectable()
export class PlatformSettingsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly actors: ActorService,
  ) {}

  async snapshot(userId: string) {
    this.settings.assertStaff(await this.actors.resolve(userId));
    return this.settings.snapshot();
  }

  async save(
    user: RequestUser,
    dto: SavePlatformSettingsDto,
    reauthToken?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    return this.settings.save(
      actor,
      dto.changes,
      dto.reason,
      reauthToken,
      user.sid,
    );
  }

  async history(userId: string, query: PlatformSettingsHistoryQueryDto) {
    this.settings.assertHistoryPermission(await this.actors.resolve(userId));
    return this.settings.history(query);
  }
}
