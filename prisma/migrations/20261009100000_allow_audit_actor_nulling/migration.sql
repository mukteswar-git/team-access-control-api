CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Audit logs are append-only';
    END IF;

    IF
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.action IS DISTINCT FROM OLD.action
        OR NEW.result IS DISTINCT FROM OLD.result
        OR NEW.target_type IS DISTINCT FROM OLD.target_type
        OR NEW.target_id IS DISTINCT FROM OLD.target_id
        OR NEW.metadata IS DISTINCT FROM OLD.metadata
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR (
            NEW.actor_user_id IS NOT NULL
            AND NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
        )
        OR (
            NEW.actor_membership_id IS NOT NULL
            AND NEW.actor_membership_id IS DISTINCT FROM OLD.actor_membership_id
        )
    THEN
        RAISE EXCEPTION 'Audit logs are append-only';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
