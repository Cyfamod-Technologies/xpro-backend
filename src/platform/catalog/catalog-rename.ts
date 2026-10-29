import { Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';

type ProfileDb = Pick<Prisma.TransactionClient, 'providerProfile'>;
type Rename = { root: string | null; from: string; to: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const swap = (names: unknown, from: string, to: string): unknown => {
  if (!Array.isArray(names)) return names;
  const renamed = (names as unknown[]).map((name) =>
    name === from ? to : name,
  );
  return renamed.filter((name, index) => renamed.indexOf(name) === index);
};

/** `services` is a list of root names; `skills` maps a root name to its skill names. */
export function renameInProfile(
  profile: { services: unknown; skills: unknown },
  { root, from, to }: Rename,
): { services: unknown; skills: unknown } {
  if (root === null) {
    const skills = isRecord(profile.skills)
      ? Object.fromEntries(
          Object.entries(profile.skills).map(([name, value]) => [
            name === from ? to : name,
            value,
          ]),
        )
      : profile.skills;
    return { services: swap(profile.services, from, to), skills };
  }
  const skills = isRecord(profile.skills)
    ? {
        ...profile.skills,
        ...(root in profile.skills
          ? { [root]: swap(profile.skills[root], from, to) }
          : {}),
      }
    : profile.skills;
  return { services: profile.services, skills };
}

/**
 * Rewrites a renamed root (`root` null) or skill (`root` is the top-level name)
 * in every provider profile and its pending changes, so providers keep matching.
 */
export async function renameInProfiles(
  tx: ProfileDb,
  rename: Rename,
): Promise<number> {
  const profiles = await tx.providerProfile.findMany({
    select: { id: true, services: true, skills: true, pendingChanges: true },
  });
  let changed = 0;
  for (const profile of profiles) {
    const live = renameInProfile(profile, rename);
    const pending = isRecord(profile.pendingChanges)
      ? renameInProfile(
          {
            services: profile.pendingChanges.services,
            skills: profile.pendingChanges.skills,
          },
          rename,
        )
      : null;
    const liveChanged =
      !isDeepStrictEqual(live.services, profile.services) ||
      !isDeepStrictEqual(live.skills, profile.skills);
    const pendingChanges = isRecord(profile.pendingChanges)
      ? profile.pendingChanges
      : null;
    const pendingChanged =
      pending !== null &&
      pendingChanges !== null &&
      (!isDeepStrictEqual(pending.services, pendingChanges.services) ||
        !isDeepStrictEqual(pending.skills, pendingChanges.skills));
    if (!liveChanged && !pendingChanged) continue;
    await tx.providerProfile.update({
      where: { id: profile.id },
      data: {
        ...(liveChanged
          ? {
              services: live.services as Prisma.InputJsonValue,
              skills: live.skills as Prisma.InputJsonValue,
            }
          : {}),
        ...(pendingChanged
          ? {
              pendingChanges: {
                ...pendingChanges,
                ...(pending.services !== undefined
                  ? { services: pending.services }
                  : {}),
                ...(pending.skills !== undefined
                  ? { skills: pending.skills }
                  : {}),
              },
            }
          : {}),
      },
    });
    changed++;
  }
  return changed;
}
