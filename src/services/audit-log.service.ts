import { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, type DatabaseClient } from "../lib/prisma.js";
import { hasPermission } from "./authorization.service.js";
import { OrganizationError } from "./organization.errors.js";

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

const auditLogQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  action: z.string().trim().min(1).optional(),
  result: z.string().trim().min(1).optional(),
  actorUserId: z.string().uuid().optional(),
  actorMembershipId: z.string().uuid().optional(),
  targetType: z.string().trim().min(1).optional(),
  targetId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const uuidSchema = z.string().uuid();

export type OrganizationAuditLogQuery = z.input<typeof auditLogQuerySchema>;

export async function getOrganizationAuditLogs(
  actorUserId: string,
  organizationId: string,
  query: OrganizationAuditLogQuery = {},
  db: DatabaseClient = prisma,
) {
  const parsedActorId = uuidSchema.safeParse(actorUserId);
  const parsedOrganizationId = uuidSchema.safeParse(organizationId);
  const parsedQuery = auditLogQuerySchema.safeParse(query);

  if (
    !parsedActorId.success ||
    !parsedOrganizationId.success ||
    !parsedQuery.success
  ) {
    throw new OrganizationError(
      "INVALID_INPUT",
      "Audit log query input is invalid.",
    );
  }

  const filters = parsedQuery.data;

  if (filters.from && filters.to && filters.from > filters.to) {
    throw new OrganizationError(
      "INVALID_INPUT",
      "The start date must not be later than the end date.",
    );
  }

  const permitted = await hasPermission(
    parsedActorId.data,
    parsedOrganizationId.data,
    "audit_log.read",
    db,
  );

  if (!permitted) {
    throw new OrganizationError(
      "FORBIDDEN",
      "You do not have permission to read audit logs for this organization.",
    );
  }

  const where: Prisma.AuditLogWhereInput = {
    organizationId: parsedOrganizationId.data,
    ...(filters.action !== undefined && { action: filters.action }),
    ...(filters.result !== undefined && { result: filters.result }),
    ...(filters.actorUserId !== undefined && {
      actorUserId: filters.actorUserId,
    }),
    ...(filters.actorMembershipId !== undefined && {
      actorMembershipId: filters.actorMembershipId,
    }),
    ...(filters.targetType !== undefined && {
      targetType: filters.targetType,
    }),
    ...(filters.targetId !== undefined && {
      targetId: filters.targetId,
    }),
    ...((filters.from !== undefined || filters.to !== undefined) && {
      createdAt: {
        ...(filters.from !== undefined && { gte: filters.from }),
        ...(filters.to !== undefined && { lte: filters.to }),
      },
    }),
  };

  const skip = (filters.page - 1) * filters.pageSize;

  const [items, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: filters.pageSize,
    }),
    db.auditLog.count({ where }),
  ]);

  return {
    items,
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.ceil(total / filters.pageSize),
  };
}
