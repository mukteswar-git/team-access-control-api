-- Restore organization-aware foreign keys for membership assignments.
-- Existing cross-organization references were checked before this migration.

-- Remove single-column foreign keys introduced by the security-events migration.
ALTER TABLE "memberships"
  DROP CONSTRAINT "memberships_admin_membership_id_fkey";

ALTER TABLE "memberships"
  DROP CONSTRAINT "memberships_manager_membership_id_fkey";

ALTER TABLE "invitations"
  DROP CONSTRAINT "invitations_admin_membership_id_fkey";

ALTER TABLE "invitations"
  DROP CONSTRAINT "invitations_manager_membership_id_fkey";

-- Membership assignments must reference memberships in the same organization.
-- RESTRICT is intentional: service code must clear references before deletion.
ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_admin_org_fk"
  FOREIGN KEY ("admin_membership_id", "organization_id")
  REFERENCES "memberships" ("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_manager_org_fk"
  FOREIGN KEY ("manager_membership_id", "organization_id")
  REFERENCES "memberships" ("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invitation assignments must also reference memberships in the same organization.
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_admin_membership_id_organization_id_fkey"
  FOREIGN KEY ("admin_membership_id", "organization_id")
  REFERENCES "memberships" ("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_manager_membership_id_organization_id_fkey"
  FOREIGN KEY ("manager_membership_id", "organization_id")
  REFERENCES "memberships" ("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
