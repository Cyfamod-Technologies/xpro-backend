# Locations

The `locations` table is the only list of places, for requests, providers and dispatch.
Every Nigerian state, LGA and state capital is seeded by the `20261031120000_locations_single_source`
migration, so nobody has to create places by hand. Decision LOC-2 in the project docs.

A place has a `kind`: `state`, `lga` or `area`. A state has no parent, an LGA sits under a state,
and an area sits under an LGA. An `lga` row stands for an LGA or a state capital that is not also
an LGA name. Each row stores `ancestor_ids` (its parents, root first), so "everything under a
state" is a single array lookup. Ids of the seeded rows are `md5('loc:' || state)` and
`md5('loc:' || state || ':' || lga)` with the version nibble set to 4 and the variant nibble to 8
(valid v4 uuids); the old Abuja rows keep their ids (`FCT` is
`00000000-0000-4000-8000-000000000001`).

**Served places.** `serviceable` is separate from `active`. A place is *served* when it and every
ancestor are active and serviceable. At launch that is FCT, Abuja Municipal, Bwari and the Abuja
areas. Serving a new place is a data change (`PUT /admin/locations/:id`), with no code change.

- **Requests** store one `location_id`: a served `lga` or `area`. Anything else fails with
  `Choose your location from the list.` Request views return `locationId`, `locationPath` (root
  first) and `locationLabel` (for example `Life Camp, Abuja Municipal, FCT`).
- **Providers** store ids only: `location_id` (an active `lga`) and `service_area_ids` (at least one
  active place, served or not). `LocationsService.validateProviderLocations` checks them. The API
  still returns `state`, `city` and `serviceAreas` as names, read from the ids, plus
  `outsideServedAreas: true` when none of the provider's areas reaches a served place.
- **Dispatch** treats a request's coverage as `[locationId, ...ancestorIds]`. A provider is eligible
  when any of their `service_area_ids` is in that list, so covering Lagos State covers every LGA and
  area in Lagos. The ranking `area` factor is 1 for the exact place, 0.6 for its parent and 0.4 for
  any higher ancestor.

`GET /locations?parentId=&serviceable=true` lists the states, or the children of `parentId`; with
`serviceable=true` only served places. `GET/POST/PUT /admin/locations` (`settings.manage`) also lists
inactive rows and enforces the parent rules, recomputing `ancestor_ids` for the row and everything
under it when the parent changes.

**Later update:** a staff screen for `/admin/locations`. Until it exists, places change by migration.
