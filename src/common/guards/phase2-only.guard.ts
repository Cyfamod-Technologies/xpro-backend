import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { requestFlowFrom } from '../utils/request-flow';

/** Preserves Phase 2 endpoints while making them unavailable during the V1 launch. */
@Injectable()
export class Phase2OnlyGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (requestFlowFrom() === 'v1') throw new NotFoundException('Not found.');
    return true;
  }
}
