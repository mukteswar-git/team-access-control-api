import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, jest, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
  createAuditLog,
  getOrganizationAuditLogs,
} from "../../src/services/audit-log.service.js";
import type { DatabaseClient } from "../../src/lib/prisma.js";

describe("createAuditLog", () => {
  it("passes the supplied fields to the database", async () => {
    const create = jest.fn(async (_args: unknown) => ({ id: "audit-1" }));
    const db = {
      auditLog: { create },
    } as unknown as DatabaseClient;

    const input = {
      organizationId: "org-1",
      actorUserId: "user-1",
      actorMembershipId: "membership-1",
      action: "organization.created",
      result: "success",
      targetType: "organization",
      targetId: "org-1",
      metadata: { source: "test" },
    };

    await createAuditLog(db, input);

    expect(create).toHaveBeenCalledWith({ data: input });
  });

  it("defaults optional fields", async () => {
    const create = jest.fn(async (_args: unknown) => ({
      id: "audit-1",
    }));

    const db = {
      auditLog: { create },
    } as unknown as DatabaseClient;

    await createAuditLog(db, {
      organizationId: "org-1",
      action: "organization.created",
      result: "success",
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        actorUserId: null,
        actorMembershipId: null,
        action: "organization.created",
        result: "success",
        targetType: null,
        targetId: null,
        metadata: {},
      },
    });
  });

  it("propagates database errors", async () => {
    const error = new Error("Audit persistence failed");
    const create = jest.fn(async () => {
      throw error;
    });
    const db = {
      auditLog: { create },
    } as unknown as DatabaseClient;

    await expect(
      createAuditLog(db, {
        organizationId: "org-1",
        action: "organization.created",
        result: "success",
      }),
    ).rejects.toThrow("Audit persistence failed");
  });
});

describe("getOrganizationAuditLogs", () => {
  afterAll(async () => {
    await disconnectTestDatabase();
  });

  async function createTestUser() {
    return prisma.user.create({
      data: {
        email: `audit-log-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });
  }

  async function createTestOrganization() {
    return prisma.organization.create({
      data: {
        name: `Audit Log Test ${randomUUID()}`,
      },
    });
  }

  async function getRoleId(code: string) {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code },
    });

    return role.id;
  }

  async function cleanupOrganization(organizationId: string) {
    await prisma.$executeRaw`
      ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
    `;

    try {
      await prisma.auditLog.deleteMany({
        where: { organizationId },
      });
    } finally {
      await prisma.$executeRaw`
        ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
      `;
    }

    await prisma.membership.deleteMany({
      where: { organizationId },
    });

    await prisma.organization.deleteMany({
      where: { id: organizationId },
    });
  }

  test("returns organization-scoped logs with pagination metadata", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      await createAuditLog(prisma, {
        organizationId: organization.id,
        actorUserId: user.id,
        action: "membership.removed",
        result: "success",
      });

      const result = await getOrganizationAuditLogs(user.id, organization.id);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.organizationId).toBe(organization.id);
      expect(result.items[0]?.action).toBe("membership.removed");
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects actors without audit-log read permission", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
        },
      });

      await expect(
        getOrganizationAuditLogs(user.id, organization.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects invalid pagination input", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      await expect(
        getOrganizationAuditLogs(user.id, organization.id, { page: 0 }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not return audit logs from another organization", async () => {
    const user = await createTestUser();
    const organizationA = await createTestOrganization();
    const organizationB = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organizationA.id,
          roleId: await getRoleId("admin"),
        },
      });

      await createAuditLog(prisma, {
        organizationId: organizationA.id,
        action: "organization.updated",
        result: "success",
        metadata: { source: "organization-a" },
      });

      await createAuditLog(prisma, {
        organizationId: organizationB.id,
        action: "organization.deleted",
        result: "success",
        metadata: { source: "organization-b" },
      });

      const result = await getOrganizationAuditLogs(user.id, organizationA.id);

      expect(result.items).toHaveLength(1);
      expect(
        result.items.every((item) => item.organizationId === organizationA.id),
      ).toBe(true);
      expect(result.items[0]?.action).toBe("organization.updated");
      expect(result.total).toBe(1);
    } finally {
      await cleanupOrganization(organizationA.id);
      await cleanupOrganization(organizationB.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("filters audit logs by action and result", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      await createAuditLog(prisma, {
        organizationId: organization.id,
        action: "membership.created",
        result: "success",
      });

      await createAuditLog(prisma, {
        organizationId: organization.id,
        action: "membership.removed",
        result: "success",
      });

      await createAuditLog(prisma, {
        organizationId: organization.id,
        action: "membership.removed",
        result: "failure",
      });

      const result = await getOrganizationAuditLogs(user.id, organization.id, {
        action: "membership.removed",
        result: "success",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.action).toBe("membership.removed");
      expect(result.items[0]?.result).toBe("success");
      expect(result.total).toBe(1);
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("filters audit logs by creation date range", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const beforeRange = new Date("2025-01-01T00:00:00.000Z");
      const withinRange = new Date("2025-06-15T12:00:00.000Z");
      const afterRange = new Date("2025-12-31T00:00:00.000Z");

      await prisma.auditLog.create({
        data: {
          organizationId: organization.id,
          action: "test.before",
          result: "success",
          createdAt: beforeRange,
        },
      });

      await prisma.auditLog.create({
        data: {
          organizationId: organization.id,
          action: "test.within",
          result: "success",
          createdAt: withinRange,
        },
      });

      await prisma.auditLog.create({
        data: {
          organizationId: organization.id,
          action: "test.after",
          result: "success",
          createdAt: afterRange,
        },
      });

      const result = await getOrganizationAuditLogs(user.id, organization.id, {
        from: new Date("2025-06-01T00:00:00.000Z"),
        to: new Date("2025-06-30T23:59:59.999Z"),
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.action).toBe("test.within");
      expect(result.total).toBe(1);
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("filters audit logs by actor and target type", async () => {
    const user = await createTestUser();
    const otherUser = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      await createAuditLog(prisma, {
        organizationId: organization.id,
        actorUserId: user.id,
        action: "membership.updated",
        result: "success",
        targetType: "membership",
      });

      await createAuditLog(prisma, {
        organizationId: organization.id,
        actorUserId: otherUser.id,
        action: "membership.updated",
        result: "success",
        targetType: "membership",
      });

      await createAuditLog(prisma, {
        organizationId: organization.id,
        actorUserId: user.id,
        action: "organization.updated",
        result: "success",
        targetType: "organization",
      });

      const result = await getOrganizationAuditLogs(user.id, organization.id, {
        actorUserId: user.id,
        targetType: "membership",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.actorUserId).toBe(user.id);
      expect(result.items[0]?.targetType).toBe("membership");
      expect(result.total).toBe(1);
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.deleteMany({
        where: { id: { in: [user.id, otherUser.id] } },
      });
    }
  });

  test("filters audit logs by actor membership and target ID", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();
    const targetId = randomUUID();

    try {
      const membership = await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      await createAuditLog(prisma, {
        organizationId: organization.id,
        actorUserId: user.id,
        actorMembershipId: membership.id,
        action: "membership.updated",
        result: "success",
        targetType: "membership",
        targetId,
      });

      await createAuditLog(prisma, {
        organizationId: organization.id,
        actorUserId: user.id,
        actorMembershipId: membership.id,
        action: "membership.updated",
        result: "success",
        targetType: "membership",
        targetId: randomUUID(),
      });

      const result = await getOrganizationAuditLogs(user.id, organization.id, {
        actorMembershipId: membership.id,
        targetId,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.actorMembershipId).toBe(membership.id);
      expect(result.items[0]?.targetId).toBe(targetId);
      expect(result.total).toBe(1);
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("paginates audit logs and reports total pages", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      for (let i = 0; i < 3; i++) {
        await createAuditLog(prisma, {
          organizationId: organization.id,
          action: `test.event.${i}`,
          result: "success",
        });
      }

      const firstPage = await getOrganizationAuditLogs(
        user.id,
        organization.id,
        { page: 1, pageSize: 2 },
      );

      const secondPage = await getOrganizationAuditLogs(
        user.id,
        organization.id,
        { page: 2, pageSize: 2 },
      );

      expect(firstPage.items).toHaveLength(2);
      expect(secondPage.items).toHaveLength(1);
      expect(firstPage.total).toBe(3);
      expect(firstPage.totalPages).toBe(2);
      expect(secondPage.totalPages).toBe(2);

      const firstIds = firstPage.items.map((item) => item.id);
      const secondIds = secondPage.items.map((item) => item.id);

      expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("returns an empty result when no audit logs match", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();
    const roleId = await getRoleId("admin");

    await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        roleId,
      },
    });

    try {
      const result = await getOrganizationAuditLogs(
        user.id,
        organization.id,
        { action: "nonexistent.action" },
        prisma,
      );

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects a date range where from is later than to", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      await expect(
        getOrganizationAuditLogs(user.id, organization.id, {
          from: new Date("2025-12-31T00:00:00.000Z"),
          to: new Date("2025-01-01T00:00:00.000Z"),
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("propagates database errors when reading audit logs", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();
    const databaseError = new Error("Database query failed");

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const db = {
        auditLog: {
          findMany: jest
            .fn<() => Promise<unknown[]>>()
            .mockRejectedValue(databaseError),
          count: jest.fn<() => Promise<number>>().mockResolvedValue(0),
        },
        membership: {
          findUnique: jest.fn<() => Promise<unknown>>().mockResolvedValue({
            id: randomUUID(),
            role: {
              rolePermissions: [
                {
                  permission: { code: "audit_log.read" },
                },
              ],
            },
          }),
        },
      } as unknown as DatabaseClient;

      await expect(
        getOrganizationAuditLogs(user.id, organization.id, {}, db),
      ).rejects.toBe(databaseError);
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
