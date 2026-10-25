import type { GuardRegistry } from './allowed-actions';
import { INTAKE_GUARDS } from './intake-guards';
import { MESSAGE_GUARDS } from './message-guards';
import { UPDATE_GUARDS } from './request-update-guards';
import { OWNERSHIP_GUARDS } from './ownership-guards';
import { DISPATCH_GUARDS } from './dispatch-guards';
import { LIFECYCLE_GUARDS } from './lifecycle-guards';
import { PRICING_GUARDS } from './pricing-guards';
import { PAYMENT_GUARDS } from './payment-guards';
import { ESCALATION_GUARDS } from './escalation-guards';

/** Compose feature guard groups here as lifecycle commands are added. */
export function composeRequestGuards(
  ...groups: GuardRegistry[]
): GuardRegistry {
  const registry: Record<string, GuardRegistry[string]> = {};
  for (const group of groups) {
    for (const [name, guard] of Object.entries(group)) {
      registry[name] = guard;
    }
  }
  return registry;
}

export const REQUEST_GUARDS = composeRequestGuards(
  INTAKE_GUARDS,
  MESSAGE_GUARDS,
  UPDATE_GUARDS,
  OWNERSHIP_GUARDS,
  DISPATCH_GUARDS,
  LIFECYCLE_GUARDS,
  PRICING_GUARDS,
  PAYMENT_GUARDS,
  ESCALATION_GUARDS,
);
