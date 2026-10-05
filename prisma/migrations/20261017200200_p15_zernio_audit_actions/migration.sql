-- ShapesOS Phase 15.4 (zernio): audit actions for the Zernio connect flow
-- (app/api/zernio/*): a connect started, an account recorded on the
-- workspace's profile, the connection turned on in every project.

-- AlterEnum
ALTER TYPE "FileChangeAction" ADD VALUE 'zernio_connect_started';
ALTER TYPE "FileChangeAction" ADD VALUE 'zernio_account_connected';
ALTER TYPE "FileChangeAction" ADD VALUE 'zernio_projects_bound';
