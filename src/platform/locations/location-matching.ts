export type MatchableLocation = {
  id: string;
  kind: string;
  name: string;
  aliases: string[];
};

const normalize = (value: string) => value.trim().toLocaleLowerCase('en');

export function matchLocationName(
  value: string,
  locations: MatchableLocation[],
  kind?: string,
) {
  const candidate = normalize(value);
  return locations.find(
    (location) =>
      (!kind || location.kind === kind) &&
      [location.name, ...location.aliases].some(
        (name) => normalize(name) === candidate,
      ),
  );
}
