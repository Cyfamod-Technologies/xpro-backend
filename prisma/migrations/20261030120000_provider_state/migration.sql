-- Providers pick their state and city from the built-in Nigeria list; existing profiles have no state.
ALTER TABLE "provider_profiles" ADD COLUMN "state" TEXT;
