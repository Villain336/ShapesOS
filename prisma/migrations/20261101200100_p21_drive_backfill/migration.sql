-- ShapesOS Phase 21B (WS=drive): backfill for rows that pre-date Drive.
-- Idempotent and non-destructive: logical_path is never touched.
--   1. workspace_folders for every directory that holds a live file (the four
--      legacy roots are marked system);
--   2. parent links between them;
--   3. workspace_files.path_key for live files (the first of two paths that
--      differ only by case keeps the key; the other stays NULL and is not
--      covered by the new unique index — both keep working).
-- workspace_folders is FORCE RLS (the table owner is bound by the policy too),
-- so the per-workspace loop sets the app.workspace_id GUC before it writes.

DO $$
DECLARE
  ws TEXT;
BEGIN
  FOR ws IN SELECT DISTINCT workspace_id FROM workspace_files LOOP
    PERFORM set_config('app.workspace_id', ws, true);

    WITH dirs AS (
      SELECT DISTINCT
        f.workspace_id,
        '/' || array_to_string((string_to_array(trim(leading '/' from f.logical_path), '/'))[1:n], '/') AS path
      FROM workspace_files f,
        LATERAL generate_series(1, cardinality(string_to_array(trim(leading '/' from f.logical_path), '/')) - 1) AS n
      WHERE f.workspace_id = ws AND f.trashed_at IS NULL
    )
    INSERT INTO workspace_folders (id, workspace_id, path, path_key, name, system, created_by, created_at, updated_at)
    SELECT
      gen_random_uuid()::text,
      workspace_id,
      path,
      lower(path),
      (string_to_array(path, '/'))[cardinality(string_to_array(path, '/'))],
      path IN ('/skills', '/memory', '/artifacts', '/files'),
      'system',
      now(),
      now()
    FROM dirs
    ON CONFLICT (workspace_id, path_key) WHERE trashed_at IS NULL DO NOTHING;

    UPDATE workspace_folders c
       SET parent_id = p.id
      FROM workspace_folders p
     WHERE c.workspace_id = ws
       AND p.workspace_id = ws
       AND c.parent_id IS NULL
       AND c.trashed_at IS NULL
       AND p.trashed_at IS NULL
       AND c.path ~ '^/[^/]+/.+'
       AND p.path = regexp_replace(c.path, '/[^/]+$', '');
  END LOOP;
END $$;

UPDATE workspace_files f
   SET path_key = lower(f.logical_path)
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY workspace_id, lower(logical_path) ORDER BY created_at, id) AS rn
      FROM workspace_files
     WHERE trashed_at IS NULL AND path_key IS NULL
  ) d
 WHERE f.id = d.id AND d.rn = 1
   AND NOT EXISTS (
     SELECT 1 FROM workspace_files o
      WHERE o.workspace_id = f.workspace_id AND o.trashed_at IS NULL
        AND o.path_key = lower(f.logical_path) AND o.id <> f.id
   );
