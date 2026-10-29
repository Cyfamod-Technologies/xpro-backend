import { Prisma, PrismaClient } from '@prisma/client';
import { loadCatalog } from '../platform/catalog/catalog.tree';
import type { CatalogIndex } from '../platform/catalog/catalog.types';
import { idsFromNames } from '../platform/catalog/provider-skills';

export type ProfileSkills = {
  services: unknown;
  skills: unknown;
  serviceIds: unknown;
  skillIds: unknown;
  pendingChanges: unknown;
};

export type SkillsBackfill = {
  serviceIds: string[];
  skillIds: Record<string, string[]>;
  pendingChanges: Record<string, unknown> | null;
  unmatched: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

/** What to write for a profile, or null when it already has ids. */
export function backfillSkills(
  catalog: CatalogIndex,
  profile: ProfileSkills,
): SkillsBackfill | null {
  if (profile.serviceIds !== null && profile.skillIds !== null) return null;
  const live = idsFromNames(catalog, names(profile.services), profile.skills);
  const pending = profile.pendingChanges;
  const pendingNeedsIds =
    isRecord(pending) &&
    Array.isArray(pending.services) &&
    isRecord(pending.skills) &&
    !('serviceIds' in pending) &&
    !('skillIds' in pending);
  const held = pendingNeedsIds
    ? idsFromNames(catalog, names(pending.services), pending.skills)
    : null;
  return {
    serviceIds: live.serviceIds,
    skillIds: live.skillIds,
    pendingChanges:
      held && isRecord(pending)
        ? { ...pending, serviceIds: held.serviceIds, skillIds: held.skillIds }
        : null,
    unmatched: [...live.unmatched, ...(held?.unmatched ?? [])],
  };
}

async function main() {
  const prisma = new PrismaClient();
  const dryRun = process.argv.includes('--dry-run');
  try {
    const catalog = await loadCatalog(prisma);
    const profiles = await prisma.providerProfile.findMany({
      where: {
        OR: [
          { serviceIds: { equals: Prisma.DbNull } },
          { skillIds: { equals: Prisma.DbNull } },
        ],
      },
      select: {
        id: true,
        services: true,
        skills: true,
        serviceIds: true,
        skillIds: true,
        pendingChanges: true,
      },
    });

    let updated = 0;
    let unmatchedCount = 0;
    for (const profile of profiles) {
      const plan = backfillSkills(catalog, profile);
      if (!plan) continue;
      for (const name of plan.unmatched) {
        console.warn(`Unmatched provider skill: ${profile.id} — ${name}`);
        unmatchedCount += 1;
      }
      updated += 1;
      if (dryRun) continue;
      // Raw SQL so updated_at, which orders the admin review queue, stays as it is.
      await prisma.$executeRaw`UPDATE provider_profiles
        SET service_ids = ${JSON.stringify(plan.serviceIds)}::jsonb,
            skill_ids = ${JSON.stringify(plan.skillIds)}::jsonb,
            pending_changes = COALESCE(${plan.pendingChanges ? JSON.stringify(plan.pendingChanges) : null}::jsonb, pending_changes)
        WHERE id = ${profile.id}`;
    }
    console.log(
      `${dryRun ? 'Would update' : 'Updated'} ${updated} provider profile(s); ${unmatchedCount} unmatched name(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
