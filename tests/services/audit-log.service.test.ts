import { describe, expect, it, jest } from "@jest/globals";
import { createAuditLog } from "../../src/services/audit-log.service.js";
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
