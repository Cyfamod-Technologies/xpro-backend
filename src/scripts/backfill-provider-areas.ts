import { PrismaClient } from '@prisma/client';
import { matchLocationName } from '../platform/locations/location-matching';

const prisma = new PrismaClient();

async function main() {
  const [locations, profiles] = await Promise.all([
    prisma.location.findMany({
      select: { id: true, kind: true, name: true, aliases: true },
    }),
    prisma.providerProfile.findMany({
      select: {
        id: true,
        city: true,
        cityId: true,
        serviceAreas: true,
        serviceAreaIds: true,
      },
    }),
  ]);

  let updated = 0;
  for (const profile of profiles) {
    const areas = Array.isArray(profile.serviceAreas)
      ? profile.serviceAreas.filter(
          (area): area is string => typeof area === 'string',
        )
      : [];
    const city = matchLocationName(profile.city, locations, 'city');
    const matchedAreas = areas
      .map((name) => matchLocationName(name, locations))
      .filter((location): location is (typeof locations)[number] => Boolean(location));
    const areaIds = [
      ...new Set([
        ...profile.serviceAreaIds,
        ...matchedAreas.map(({ id }) => id),
      ]),
    ];
    const unmatched = areas.filter(
      (name) => !matchLocationName(name, locations),
    );
    if (!city && profile.city)
      console.warn(`Unmatched provider city: ${profile.id} — ${profile.city}`);
    for (const name of unmatched)
      console.warn(`Unmatched provider service area: ${profile.id} — ${name}`);

    const cityId = profile.cityId ?? city?.id ?? null;
    if (
      cityId === profile.cityId &&
      areaIds.length === profile.serviceAreaIds.length
    )
      continue;
    await prisma.providerProfile.update({
      where: { id: profile.id },
      data: { cityId, serviceAreaIds: areaIds },
    });
    updated += 1;
  }
  console.log(`Updated ${updated} provider profile(s).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
