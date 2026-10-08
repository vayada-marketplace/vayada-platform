-- VAY-1362-6C pre-deploy check, counted copy for the read-only counts run (scripts/legacy-migration-oneoff.sh).
-- Derived from the 6c owner's reference query. Only change: the per-property column is count(*) instead of
-- an aggregate that concatenated the source system and table, so the check needs no string concatenation.
-- The counts tool wraps each SELECT as SELECT count(*), so only the number of matching rows is reported.

-- Properties the new guard would refuse for Channex enable today: any non-platform source link and no
-- Channex binding claim. Expected before the legacy import: 0. Any hit must be explained before the guard ships.
BEGIN READ ONLY;
SELECT property.id, property.profile_status, count(*) AS source_links
FROM hotel_catalog.properties property
JOIN hotel_catalog.property_source_links link
  ON link.property_id = property.id AND link.source_system <> 'platform'
WHERE NOT EXISTS (
  SELECT 1 FROM pms.channel_binding_claims claim
  WHERE claim.property_id = property.id AND claim.provider = 'channex')
GROUP BY property.id, property.profile_status
ORDER BY property.id;
-- Channex enable jobs queued before the guard for such properties: the worker would still process them and
-- create a second Channex property. Expected: 0. Any hit needs an audited cancel first.
SELECT job.id, job.property_id, job.status
FROM platform.jobs job
WHERE job.queue_name = 'pms.channex.management' AND job.job_type = 'channex.enable'
  AND job.status IN ('pending', 'running')
  AND EXISTS (SELECT 1 FROM hotel_catalog.property_source_links link
    WHERE link.property_id = job.property_id AND link.source_system <> 'platform')
  AND NOT EXISTS (SELECT 1 FROM pms.channel_binding_claims claim
    WHERE claim.property_id = job.property_id AND claim.provider = 'channex');
ROLLBACK;
