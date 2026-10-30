# Provider locations

Providers choose a **state** and a **city** (an LGA or the state capital) from the
built-in Nigeria list in `src/platform/locations/nigerian-states.ts`. It is generated
from the dashboard's `utils/nigeria-locations.ts`; keep the two in step. No admin has to
create states or cities, so a provider anywhere in Nigeria can submit a profile.

`LocationsService.resolveProviderLocationIds` resolves a submission:

- **City:** a managed city (the `locations` table, today Abuja) keeps its id in
  `provider_profiles.city_id`. Any other city must be a valid LGA or capital of the chosen
  state, is stored by name, and leaves `city_id` null. A city sent without its state, or
  with the wrong state, fails with `Choose your state and city from the list.` Apply the
  `20261030120000_provider_state` migration; existing profiles have a null `state`.
- **Service areas:** a managed city or district keeps its id in `service_area_ids`. Any
  other area must be a built-in LGA, state capital or state and is stored by name only.
  An unknown name fails with `Choose service areas from the location list.`

Dispatch matches on managed location ids, so a provider whose areas are all name-only is
saved and reviewed but is not offered jobs yet. Customer requests still choose a managed
city and district.

**Later update:** admin-managed locations, where admins add states, cities and districts
and dispatch uses them outside Abuja. Nothing in the admin API needs to change until then;
`POST/PUT /admin/locations` stays as it is. See decision LOC-1 in the project docs.
