import { catalogSeed } from './catalog/seed-catalog';
import type { Seed } from './seed.types';

/** Seeds in the order they run. Add a new one to this list. */
export const SEEDS: readonly Seed[] = [catalogSeed];
