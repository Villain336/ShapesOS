-- Race-safe backstop for concurrent booking submissions on the same slot.
-- Two requests that both pass the application-level clash check at the same
-- instant cannot both insert the same (page, startAt) while scheduled:
-- the second gets a unique violation (P2002) and is served a 409.
-- Note: this guards exact-start collisions (the slots the availability
-- walk generates). It does not prevent overlapping bookings with
-- different startAt values; those remain guarded by the app-level check.
CREATE UNIQUE INDEX "booking_pageId_startAt_scheduled_unique"
  ON "booking"("page_id", "start_at")
  WHERE "status" = 'scheduled';
