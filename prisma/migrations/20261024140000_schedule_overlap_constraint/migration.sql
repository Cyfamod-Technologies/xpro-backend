ALTER TABLE schedules
  ADD CONSTRAINT schedules_confirmed_provider_no_overlap
  EXCLUDE USING gist (
    provider_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  )
  WHERE (status = 'confirmed');
