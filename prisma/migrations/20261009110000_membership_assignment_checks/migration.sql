-- Super Users cannot have reporting assignments.
ALTER TABLE "memberships"
ADD CONSTRAINT "memberships_super_user_no_reporting_assignments_check"
CHECK (
    "role_id" <> '00000000-0000-0000-0000-000000000001'
    OR (
        "admin_membership_id" IS NULL
        AND "manager_membership_id" IS NULL
    )
);

-- Admins cannot have reporting assignments.
ALTER TABLE "memberships"
ADD CONSTRAINT "memberships_admin_no_reporting_assignments_check"
CHECK (
    "role_id" <> '00000000-0000-0000-0000-000000000002'
    OR (
        "admin_membership_id" IS NULL
        AND "manager_membership_id" IS NULL
    )
);

-- Managers cannot be assigned to another Manager.
ALTER TABLE "memberships"
ADD CONSTRAINT "memberships_manager_no_manager_assignment_check"
CHECK (
    "role_id" <> '00000000-0000-0000-0000-000000000003'
    OR "manager_membership_id" IS NULL
);

-- Members cannot be assigned directly to an Admin.
ALTER TABLE "memberships"
ADD CONSTRAINT "memberships_member_no_admin_assignment_check"
CHECK (
    "role_id" <> '00000000-0000-0000-0000-000000000004'
    OR "admin_membership_id" IS NULL
);
