import type { Prisma } from "../generated/prisma/client.js";
import type { DatabaseClient } from "../lib/prisma.js";

type CreateAuditLogInput = {
  organizationId: string;
  actorUserId?: string | null;
  actorMembershipId?: string | null;
  action: string;
  result: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export async function createAuditLog(
  db: DatabaseClient,
  input: CreateAuditLogInput,
) {
  return db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? null,
      actorMembershipId: input.actorMembershipId ?? null,
      action: input.action,
      result: input.result,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
    },
  });
}
