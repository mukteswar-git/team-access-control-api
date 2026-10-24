-- Allow Members to be assigned directly to an Admin.
ALTER TABLE "memberships"
DROP CONSTRAINT "memberships_member_no_admin_assignment_check";

-- A Member can be assigned to an Admin, a Manager, or neither,
-- but cannot be assigned to both simultaneously.
ALTER TABLE "memberships"
ADD CONSTRAINT "memberships_member_single_parent_check"
CHECK (
    "role_id" <> '00000000-0000-0000-0000-000000000004'
    OR "admin_membership_id" IS NULL
    OR "manager_membership_id" IS NULL
);
