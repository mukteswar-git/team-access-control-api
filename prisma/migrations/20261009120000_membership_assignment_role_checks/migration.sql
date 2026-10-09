-- Ensure membership assignments reference memberships with the correct roles.
CREATE OR REPLACE FUNCTION check_membership_assignment_roles()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    assigned_role_id UUID;
BEGIN
    -- A manager must be assigned to an admin.
    IF NEW.admin_membership_id IS NOT NULL THEN
        SELECT role_id
        INTO assigned_role_id
        FROM memberships
        WHERE id = NEW.admin_membership_id
          AND organization_id = NEW.organization_id;

        IF assigned_role_id IS DISTINCT FROM
           '00000000-0000-0000-0000-000000000002'::UUID
        THEN
            RAISE EXCEPTION
                'admin_membership_id must reference an admin membership';
        END IF;
    END IF;

    -- A member must be assigned to a manager.
    IF NEW.manager_membership_id IS NOT NULL THEN
        SELECT role_id
        INTO assigned_role_id
        FROM memberships
        WHERE id = NEW.manager_membership_id
          AND organization_id = NEW.organization_id;

        IF assigned_role_id IS DISTINCT FROM
           '00000000-0000-0000-0000-000000000003'::UUID
        THEN
            RAISE EXCEPTION
                'manager_membership_id must reference a manager membership';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_validate_assignment_roles
BEFORE INSERT OR UPDATE OF
    role_id,
    organization_id,
    admin_membership_id,
    manager_membership_id
ON memberships
FOR EACH ROW
EXECUTE FUNCTION check_membership_assignment_roles();


-- Prevent role changes that would invalidate existing assignments.

CREATE OR REPLACE FUNCTION check_membership_referenced_role()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- A membership referenced as an admin must remain an admin.
    IF NEW.role_id IS DISTINCT FROM OLD.role_id
       AND EXISTS (
           SELECT 1
           FROM memberships
           WHERE admin_membership_id = NEW.id
             AND organization_id = NEW.organization_id
       )
       AND NEW.role_id <> '00000000-0000-0000-0000-000000000002'::UUID
    THEN
        RAISE EXCEPTION
            'Cannot change role: membership is assigned as an admin';
    END IF;

    -- A membership referenced as a manager must remain a manager.
    IF NEW.role_id IS DISTINCT FROM OLD.role_id
       AND EXISTS (
           SELECT 1
           FROM memberships
           WHERE manager_membership_id = NEW.id
             AND organization_id = NEW.organization_id
       )
       AND NEW.role_id <> '00000000-0000-0000-0000-000000000003'::UUID
    THEN
        RAISE EXCEPTION
            'Cannot change role: membership is assigned as a manager';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_validate_referenced_role
BEFORE UPDATE OF role_id
ON memberships
FOR EACH ROW
EXECUTE FUNCTION check_membership_referenced_role();
