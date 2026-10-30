import { NIGERIAN_STATES } from './nigerian-states';

const same = (a: string, b: string) =>
  a.trim().toLocaleLowerCase('en') === b.trim().toLocaleLowerCase('en');

export function findBuiltInState(name?: string) {
  if (!name?.trim()) return undefined;
  return NIGERIAN_STATES.find((state) => same(state.name, name));
}

/**
 * A city is an LGA or the capital of a state. When the state is sent it must contain the city. When it is missing the
 * city is accepted only if exactly one state has it, because a few LGA names (such as Obi or Irepodun) repeat.
 */
export function findBuiltInCity(stateName?: string, cityName?: string) {
  if (!cityName?.trim()) return undefined;
  const inState = (state: (typeof NIGERIAN_STATES)[number]) => {
    const city = [...state.lgas, state.capital].find((name) =>
      same(name, cityName),
    );
    return city ? { state: state.name, city } : undefined;
  };
  if (stateName?.trim()) {
    const state = findBuiltInState(stateName);
    return state ? inState(state) : undefined;
  }
  const matches = NIGERIAN_STATES.flatMap((state) => inState(state) ?? []);
  return matches.length === 1 ? matches[0] : undefined;
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
