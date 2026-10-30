import { NIGERIAN_STATES } from './nigerian-states';

const same = (a: string, b: string) =>
  a.trim().toLocaleLowerCase('en') === b.trim().toLocaleLowerCase('en');

export function findBuiltInState(name?: string) {
  if (!name?.trim()) return undefined;
  return NIGERIAN_STATES.find((state) => same(state.name, name));
}

/** A city is an LGA or the capital of the given state. The state is needed because LGA names repeat across states. */
export function findBuiltInCity(stateName?: string, cityName?: string) {
  const state = findBuiltInState(stateName);
  if (!state || !cityName?.trim()) return undefined;
  const city = [...state.lgas, state.capital].find((name) =>
    same(name, cityName),
  );
  return city ? { state: state.name, city } : undefined;
}

/** A service area outside the managed locations may be any LGA, state capital or state, spelled as the built-in list. */
export function findBuiltInArea(name?: string) {
  if (!name?.trim()) return undefined;
  for (const state of NIGERIAN_STATES) {
    if (same(state.name, name)) return state.name;
    const match = [...state.lgas, state.capital].find((candidate) =>
      same(candidate, name),
    );
    if (match) return match;
  }
  return undefined;
}
