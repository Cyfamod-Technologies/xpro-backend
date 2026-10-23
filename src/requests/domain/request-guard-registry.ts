import type { GuardRegistry } from './allowed-actions';
import { INTAKE_GUARDS } from './intake-guards';
import { MESSAGE_GUARDS } from './message-guards';
import { UPDATE_GUARDS } from './request-update-guards';
import { OWNERSHIP_GUARDS } from './ownership-guards';

/** Compose feature guard groups here as lifecycle commands are added. */
export function composeRequestGuards(...groups: GuardRegistry[]): GuardRegistry {
  return Object.assign({}, ...groups);
}

export const REQUEST_GUARDS = composeRequestGuards(INTAKE_GUARDS, MESSAGE_GUARDS, UPDATE_GUARDS, OWNERSHIP_GUARDS);
