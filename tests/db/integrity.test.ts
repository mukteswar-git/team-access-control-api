import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { env } from "../../src/config/env.js";

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
});

const prisma = new PrismaClient({
  adapter,
});

describe("Database integrity", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("rejects duplicate role codes", async () => {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    await expect(
      prisma.role.create({
        data: {
          code: role.code,
          name: "Duplicate Member Role",
          description: "Test duplicate role code",
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects duplicate permission codes", async () => {
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { code: "organization.read" },
    });

    await expect(
      prisma.permission.create({
        data: {
          code: permission.code,
          name: "Duplicate Permission",
          description: "Test duplicate permission code",
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects duplicate role-permission pairs", async () => {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    const permission = await prisma.permission.findUniqueOrThrow({
      where: { code: "organization.read" },
    });

    const existingPair = await prisma.rolePermission.findUnique({
      where: {
        roleId_permissionId: {
          roleId: role.id,
          permissionId: permission.id,
        },
      },
    });

    if (!existingPair) {
      await prisma.rolePermission.create({
        data: {
          roleId: role.id,
          permissionId: permission.id,
        },
      });
    }

    await expect(
      prisma.rolePermission.create({
        data: {
          roleId: role.id,
          permissionId: permission.id,
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects role-permission mappings with a nonexistent role", async () => {
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { code: "organization.read" },
    });

    await expect(
      prisma.rolePermission.create({
        data: {
          roleId: randomUUID(),
          permissionId: permission.id,
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects role-permission mappings with a nonexistent permission", async () => {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    await expect(
      prisma.rolePermission.create({
        data: {
          roleId: role.id,
          permissionId: randomUUID(),
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects duplicate user email", async () => {
    const email = `db-integrity-${randomUUID()}@example.com`;

    await prisma.user.create({
      data: {
        email,
        passwordHash: "hash-1",
      },
    });

    try {
      await expect(
        prisma.user.create({
          data: {
            email,
            passwordHash: "hash-2",
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.user.delete({
        where: { email },
      });
    }
  });

  test("rejects duplicate membership for the same user and organization", async () => {
    const user = await prisma.user.create({
      data: {
        email: `membership-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: {
        name: `Test Organization ${randomUUID()}`,
      },
    });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: {
        code: "member",
      },
    });

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: memberRole.id,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: user.id,
            organizationId: organization.id,
            roleId: memberRole.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: {
          userId: user.id,
          organizationId: organization.id,
        },
      });

      await prisma.organization.delete({
        where: {
          id: organization.id,
        },
      });

      await prisma.user.delete({
        where: {
          id: user.id,
        },
      });
    }
  });

  test("allows the same user to belong to different organizations", async () => {
    const user = await prisma.user.create({
      data: {
        email: `multi-org-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organizationA = await prisma.organization.create({
      data: {
        name: `Organization A ${randomUUID()}`,
      },
    });

    const organizationB = await prisma.organization.create({
      data: {
        name: `Organization B ${randomUUID()}`,
      },
    });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: {
        code: "member",
      },
    });

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organizationA.id,
          roleId: memberRole.id,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: user.id,
            organizationId: organizationB.id,
            roleId: memberRole.id,
          },
        }),
      ).resolves.toBeDefined();
    } finally {
      await prisma.membership.deleteMany({
        where: {
          userId: user.id,
        },
      });

      await prisma.organization.deleteMany({
        where: {
          id: {
            in: [organizationA.id, organizationB.id],
          },
        },
      });

      await prisma.user.delete({
        where: {
          id: user.id,
        },
      });
    }
  });

  test("rejects a second super user in the same organization", async () => {
    const userA = await prisma.user.create({
      data: {
        email: `super-user-a-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const userB = await prisma.user.create({
      data: {
        email: `super-user-b-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: {
        name: `Super User Test ${randomUUID()}`,
      },
    });

    const superUserRole = await prisma.role.findUniqueOrThrow({
      where: {
        code: "super_user",
      },
    });

    try {
      await prisma.membership.create({
        data: {
          userId: userA.id,
          organizationId: organization.id,
          roleId: superUserRole.id,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: userB.id,
            organizationId: organization.id,
            roleId: superUserRole.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: {
          organizationId: organization.id,
        },
      });

      await prisma.organization.delete({
        where: {
          id: organization.id,
        },
      });

      await prisma.user.deleteMany({
        where: {
          id: {
            in: [userA.id, userB.id],
          },
        },
      });
    }
  });

  test("rejects a manager assignment from another organization", async () => {
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const managerUser = await prisma.user.create({
      data: {
        email: `manager-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organizationA = await prisma.organization.create({
      data: {
        name: `Organization A ${randomUUID()}`,
      },
    });

    const organizationB = await prisma.organization.create({
      data: {
        name: `Organization B ${randomUUID()}`,
      },
    });

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: "admin" },
    });

    const managerRole = await prisma.role.findUniqueOrThrow({
      where: { code: "manager" },
    });

    let adminMembershipId: string | undefined;
    let managerMembershipId: string | undefined;

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: adminUser.id,
          organizationId: organizationA.id,
          roleId: adminRole.id,
        },
      });

      adminMembershipId = adminMembership.id;

      await expect(
        prisma.membership.create({
          data: {
            userId: managerUser.id,
            organizationId: organizationB.id,
            roleId: managerRole.id,
            adminMembershipId: adminMembership.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      if (adminMembershipId) {
        await prisma.membership.deleteMany({
          where: { id: adminMembershipId },
        });
      }

      await prisma.membership.deleteMany({
        where: {
          userId: { in: [adminUser.id, managerUser.id] },
        },
      });

      await prisma.organization.deleteMany({
        where: {
          id: { in: [organizationA.id, organizationB.id] },
        },
      });

      await prisma.user.deleteMany({
        where: {
          id: { in: [adminUser.id, managerUser.id] },
        },
      });
    }
  });

  test("rejects a member assignment from another organization", async () => {
    const managerUser = await prisma.user.create({
      data: {
        email: `manager-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const memberUser = await prisma.user.create({
      data: {
        email: `member-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organizationA = await prisma.organization.create({
      data: {
        name: `Organization A ${randomUUID()}`,
      },
    });

    const organizationB = await prisma.organization.create({
      data: {
        name: `Organization B ${randomUUID()}`,
      },
    });

    const managerRole = await prisma.role.findUniqueOrThrow({
      where: { code: "manager" },
    });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    try {
      const managerMembership = await prisma.membership.create({
        data: {
          userId: managerUser.id,
          organizationId: organizationA.id,
          roleId: managerRole.id,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: memberUser.id,
            organizationId: organizationB.id,
            roleId: memberRole.id,
            managerMembershipId: managerMembership.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: {
          userId: { in: [managerUser.id, memberUser.id] },
        },
      });

      await prisma.organization.deleteMany({
        where: {
          id: { in: [organizationA.id, organizationB.id] },
        },
      });

      await prisma.user.deleteMany({
        where: {
          id: { in: [managerUser.id, memberUser.id] },
        },
      });
    }
  });

  test("rejects duplicate invitation token hashes", async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Invitation Test ${randomUUID()}`,
      },
    });

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    const tokenHash = `token-hash-${randomUUID()}`;

    try {
      await prisma.invitation.create({
        data: {
          organizationId: organization.id,
          invitedEmail: "first@example.com",
          roleId: role.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      await expect(
        prisma.invitation.create({
          data: {
            organizationId: organization.id,
            invitedEmail: "second@example.com",
            roleId: role.id,
            tokenHash,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects an invitation admin assignment from another organization", async () => {
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organizationA = await prisma.organization.create({
      data: { name: `Organization A ${randomUUID()}` },
    });

    const organizationB = await prisma.organization.create({
      data: { name: `Organization B ${randomUUID()}` },
    });

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: "admin" },
    });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: adminUser.id,
          organizationId: organizationA.id,
          roleId: adminRole.id,
        },
      });

      await expect(
        prisma.invitation.create({
          data: {
            organizationId: organizationB.id,
            invitedEmail: `invited-${randomUUID()}@example.com`,
            roleId: memberRole.id,
            tokenHash: `token-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            adminMembershipId: adminMembership.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.invitation.deleteMany({
        where: {
          organizationId: { in: [organizationA.id, organizationB.id] },
        },
      });

      await prisma.membership.deleteMany({
        where: { userId: adminUser.id },
      });

      await prisma.organization.deleteMany({
        where: { id: { in: [organizationA.id, organizationB.id] } },
      });

      await prisma.user.delete({
        where: { id: adminUser.id },
      });
    }
  });

  test("rejects an invitation manager assignment from another organization", async () => {
    const managerUser = await prisma.user.create({
      data: {
        email: `manager-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organizationA = await prisma.organization.create({
      data: { name: `Organization A ${randomUUID()}` },
    });

    const organizationB = await prisma.organization.create({
      data: { name: `Organization B ${randomUUID()}` },
    });

    const managerRole = await prisma.role.findUniqueOrThrow({
      where: { code: "manager" },
    });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    try {
      const managerMembership = await prisma.membership.create({
        data: {
          userId: managerUser.id,
          organizationId: organizationA.id,
          roleId: managerRole.id,
        },
      });

      await expect(
        prisma.invitation.create({
          data: {
            organizationId: organizationB.id,
            invitedEmail: `invited-${randomUUID()}@example.com`,
            roleId: memberRole.id,
            tokenHash: `token-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            managerMembershipId: managerMembership.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.invitation.deleteMany({
        where: {
          organizationId: { in: [organizationA.id, organizationB.id] },
        },
      });

      await prisma.membership.deleteMany({
        where: { userId: managerUser.id },
      });

      await prisma.organization.deleteMany({
        where: { id: { in: [organizationA.id, organizationB.id] } },
      });

      await prisma.user.delete({
        where: { id: managerUser.id },
      });
    }
  });

  test("preserves an invitation when its creator membership is deleted", async () => {
    const creatorUser = await prisma.user.create({
      data: {
        email: `creator-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: {
        name: `Invitation Creator Test ${randomUUID()}`,
      },
    });

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: "admin" },
    });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    let invitationId: string | undefined;

    try {
      const creatorMembership = await prisma.membership.create({
        data: {
          userId: creatorUser.id,
          organizationId: organization.id,
          roleId: adminRole.id,
        },
      });

      const invitation = await prisma.invitation.create({
        data: {
          organizationId: organization.id,
          invitedEmail: `invited-${randomUUID()}@example.com`,
          roleId: memberRole.id,
          tokenHash: `token-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          createdByMembershipId: creatorMembership.id,
        },
      });

      invitationId = invitation.id;

      await prisma.membership.delete({
        where: { id: creatorMembership.id },
      });

      const survivingInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });

      expect(survivingInvitation.createdByMembershipId).toBeNull();
    } finally {
      if (invitationId) {
        await prisma.invitation.deleteMany({
          where: { id: invitationId },
        });
      }

      await prisma.membership.deleteMany({
        where: { userId: creatorUser.id },
      });

      await prisma.organization.deleteMany({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: creatorUser.id },
      });
    }
  });

  test("rejects invitations for nonexistent organizations", async () => {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    await expect(
      prisma.invitation.create({
        data: {
          organizationId: randomUUID(),
          invitedEmail: `invited-${randomUUID()}@example.com`,
          roleId: role.id,
          tokenHash: `token-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects invitations with nonexistent roles", async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Invitation Role Test ${randomUUID()}`,
      },
    });

    try {
      await expect(
        prisma.invitation.create({
          data: {
            organizationId: organization.id,
            invitedEmail: `invited-${randomUUID()}@example.com`,
            roleId: randomUUID(),
            tokenHash: `token-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.invitation.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects sessions for nonexistent users", async () => {
    await expect(
      prisma.session.create({
        data: {
          userId: randomUUID(),
          tokenHash: `session-token-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects duplicate session token hashes", async () => {
    const user = await prisma.user.create({
      data: {
        email: `session-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const tokenHash = `session-token-${randomUUID()}`;

    try {
      await prisma.session.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      await expect(
        prisma.session.create({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.session.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("deletes a user's sessions when the user is deleted", async () => {
    const user = await prisma.user.create({
      data: {
        email: `session-cascade-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    try {
      await prisma.session.createMany({
        data: [
          {
            userId: user.id,
            tokenHash: `session-token-a-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
          {
            userId: user.id,
            tokenHash: `session-token-b-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        ],
      });

      await prisma.user.delete({
        where: { id: user.id },
      });

      const remainingSessions = await prisma.session.count({
        where: { userId: user.id },
      });

      expect(remainingSessions).toBe(0);
    } finally {
      await prisma.session.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.deleteMany({
        where: { id: user.id },
      });
    }
  });

  test("deletes a user's email verification tokens when the user is deleted", async () => {
    const user = await prisma.user.create({
      data: {
        email: `verification-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    try {
      await prisma.emailVerificationToken.createMany({
        data: [
          {
            userId: user.id,
            tokenHash: `verification-token-a-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
          {
            userId: user.id,
            tokenHash: `verification-token-b-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        ],
      });

      await prisma.user.delete({
        where: { id: user.id },
      });

      const remainingTokens = await prisma.emailVerificationToken.count({
        where: { userId: user.id },
      });

      expect(remainingTokens).toBe(0);
    } finally {
      await prisma.emailVerificationToken.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.deleteMany({
        where: { id: user.id },
      });
    }
  });

  test("deletes a user's password reset tokens when the user is deleted", async () => {
    const user = await prisma.user.create({
      data: {
        email: `password-reset-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    try {
      await prisma.passwordResetToken.createMany({
        data: [
          {
            userId: user.id,
            tokenHash: `reset-token-a-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
          {
            userId: user.id,
            tokenHash: `reset-token-b-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        ],
      });

      await prisma.user.delete({
        where: { id: user.id },
      });

      const remainingTokens = await prisma.passwordResetToken.count({
        where: { userId: user.id },
      });

      expect(remainingTokens).toBe(0);
    } finally {
      await prisma.passwordResetToken.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.deleteMany({
        where: { id: user.id },
      });
    }
  });

  test("rejects audit logs for nonexistent organizations", async () => {
    await expect(
      prisma.auditLog.create({
        data: {
          organizationId: randomUUID(),
          action: "test.action",
          result: "success",
        },
      }),
    ).rejects.toThrow();
  });

  test("preserves audit logs when the actor membership is deleted", async () => {
    const user = await prisma.user.create({
      data: {
        email: `audit-actor-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: {
        name: `Audit Test ${randomUUID()}`,
      },
    });

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    let auditLogId: string | undefined;

    try {
      const membership = await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: role.id,
        },
      });

      const auditLog = await prisma.auditLog.create({
        data: {
          organizationId: organization.id,
          actorUserId: user.id,
          actorMembershipId: membership.id,
          action: "test.audit",
          result: "success",
        },
      });

      auditLogId = auditLog.id;

      await prisma.membership.delete({
        where: { id: membership.id },
      });

      const survivingLog = await prisma.auditLog.findUniqueOrThrow({
        where: { id: auditLog.id },
      });

      expect(survivingLog.actorMembershipId).toBeNull();
      expect(survivingLog.actorUserId).toBe(user.id);
    } finally {
      if (auditLogId) {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
        `;

        try {
          await prisma.auditLog.deleteMany({
            where: { id: auditLogId },
          });
        } finally {
          await prisma.$executeRaw`
            ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
          `;
        }
      }

      await prisma.membership.deleteMany({
        where: { userId: user.id },
      });

      await prisma.organization.deleteMany({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: user.id },
      });
    }
  });

  test("preserves audit logs when the actor user is deleted", async () => {
    const user = await prisma.user.create({
      data: {
        email: `audit-user-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: { name: `Audit Test ${randomUUID()}` },
    });

    let auditLogId: string | undefined;

    try {
      const auditLog = await prisma.auditLog.create({
        data: {
          organizationId: organization.id,
          actorUserId: user.id,
          action: "test.audit",
          result: "success",
        },
      });

      auditLogId = auditLog.id;

      await prisma.user.delete({
        where: { id: user.id },
      });

      const survivingLog = await prisma.auditLog.findUniqueOrThrow({
        where: { id: auditLog.id },
      });

      expect(survivingLog.actorUserId).toBeNull();
    } finally {
      if (auditLogId) {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
        `;

        try {
          await prisma.auditLog.deleteMany({
            where: { id: auditLogId },
          });
        } finally {
          await prisma.$executeRaw`
            ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
          `;
        }
      }

      await prisma.organization.deleteMany({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: user.id },
      });
    }
  });

  test("prevents deleting an organization that has audit logs", async () => {
    const organization = await prisma.organization.create({
      data: { name: `Audit Test ${randomUUID()}` },
    });

    let auditLogId: string | undefined;

    try {
      const auditLog = await prisma.auditLog.create({
        data: {
          organizationId: organization.id,
          action: "test.audit",
          result: "success",
        },
      });

      auditLogId = auditLog.id;

      await expect(
        prisma.organization.delete({
          where: { id: organization.id },
        }),
      ).rejects.toThrow();

      // The failed deletion must leave the organization intact.
      await expect(
        prisma.organization.findUniqueOrThrow({
          where: { id: organization.id },
        }),
      ).resolves.toBeDefined();
    } finally {
      if (auditLogId) {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
        `;

        try {
          await prisma.auditLog.deleteMany({
            where: { id: auditLogId },
          });
        } finally {
          await prisma.$executeRaw`
            ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
          `;
        }
      }

      await prisma.organization.deleteMany({
        where: { id: organization.id },
      });
    }
  });

  test("prevents updating audit logs", async () => {
    const organization = await prisma.organization.create({
      data: { name: `Audit Test ${randomUUID()}` },
    });

    let auditLogId: string | undefined;

    try {
      const auditLog = await prisma.auditLog.create({
        data: {
          organizationId: organization.id,
          action: "test.audit",
          result: "success",
        },
      });

      auditLogId = auditLog.id;

      await expect(
        prisma.auditLog.update({
          where: { id: auditLog.id },
          data: { result: "modified" },
        }),
      ).rejects.toThrow("Audit logs are append-only");

      const unchangedLog = await prisma.auditLog.findUniqueOrThrow({
        where: { id: auditLog.id },
      });

      expect(unchangedLog.result).toBe("success");
    } finally {
      if (auditLogId) {
        await prisma.$executeRaw`
          ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
        `;

        try {
          await prisma.auditLog.deleteMany({
            where: { id: auditLogId },
          });
        } finally {
          await prisma.$executeRaw`
            ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
          `;
        }
      }

      await prisma.organization.deleteMany({
        where: { id: organization.id },
      });
    }
  });

  test("prevents deleting audit logs", async () => {
    const organization = await prisma.organization.create({
      data: { name: `Audit Test ${randomUUID()}` },
    });

    let auditLogId: string | undefined;

    try {
      const auditLog = await prisma.auditLog.create({
        data: {
          organizationId: organization.id,
          action: "test.audit",
          result: "success",
        },
      });

      auditLogId = auditLog.id;

      await expect(
        prisma.auditLog.delete({
          where: { id: auditLog.id },
        }),
      ).rejects.toThrow("Audit logs are append-only");

      await expect(
        prisma.auditLog.findUniqueOrThrow({
          where: { id: auditLog.id },
        }),
      ).resolves.toBeDefined();
    } finally {
      try {
        if (auditLogId) {
          await prisma.$executeRaw`
            ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
          `;

          try {
            await prisma.auditLog.deleteMany({
              where: { id: auditLogId },
            });
          } finally {
            await prisma.$executeRaw`
              ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
            `;
          }
        }
      } finally {
        await prisma.organization.deleteMany({
          where: { id: organization.id },
        });
      }
    }
  });

  test("rejects duplicate email verification token hashes", async () => {
    const user = await prisma.user.create({
      data: {
        email: `verification-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const tokenHash = randomUUID();

    try {
      await prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await expect(
        prisma.emailVerificationToken.create({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("rejects duplicate password reset token hashes", async () => {
    const user = await prisma.user.create({
      data: {
        email: `password-reset-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const tokenHash = randomUUID();

    try {
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await expect(
        prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("rejects email verification tokens for nonexistent users", async () => {
    await expect(
      prisma.emailVerificationToken.create({
        data: {
          userId: randomUUID(),
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects password reset tokens for nonexistent users", async () => {
    await expect(
      prisma.passwordResetToken.create({
        data: {
          userId: randomUUID(),
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects memberships for nonexistent organizations", async () => {
    const user = await prisma.user.create({
      data: {
        email: `missing-org-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    try {
      await expect(
        prisma.membership.create({
          data: {
            userId: user.id,
            organizationId: randomUUID(),
            roleId: memberRole.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("rejects memberships with nonexistent roles", async () => {
    const user = await prisma.user.create({
      data: {
        email: `missing-role-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: {
        name: `Missing Role Test ${randomUUID()}`,
      },
    });

    try {
      await expect(
        prisma.membership.create({
          data: {
            userId: user.id,
            organizationId: organization.id,
            roleId: randomUUID(),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.organization.delete({
        where: { id: organization.id },
      });

      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("rejects a super user with an admin assignment", async () => {
    const adminUser = await prisma.user.create({
      data: {
        email: `assigned-admin-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const superUser = await prisma.user.create({
      data: {
        email: `assigned-super-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: {
        name: `Role Assignment Test ${randomUUID()}`,
      },
    });

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: "admin" },
    });

    const superUserRole = await prisma.role.findUniqueOrThrow({
      where: { code: "super_user" },
    });

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: adminUser.id,
          organizationId: organization.id,
          roleId: adminRole.id,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: superUser.id,
            organizationId: organization.id,
            roleId: superUserRole.id,
            adminMembershipId: adminMembership.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: {
          id: { in: [adminUser.id, superUser.id] },
        },
      });
    }
  });

  test("rejects an admin with a manager assignment", async () => {
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const managerUser = await prisma.user.create({
      data: {
        email: `manager-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: { name: `Admin Assignment ${randomUUID()}` },
    });

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: "admin" },
    });

    const managerRole = await prisma.role.findUniqueOrThrow({
      where: { code: "manager" },
    });

    try {
      const managerMembership = await prisma.membership.create({
        data: {
          userId: managerUser.id,
          organizationId: organization.id,
          roleId: managerRole.id,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: adminUser.id,
            organizationId: organization.id,
            roleId: adminRole.id,
            managerMembershipId: managerMembership.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [adminUser.id, managerUser.id] } },
      });
    }
  });

  test("rejects a manager with a manager assignment", async () => {
    const targetUser = await prisma.user.create({
      data: {
        email: `target-manager-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const assignedUser = await prisma.user.create({
      data: {
        email: `assigned-manager-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: { name: `Manager Assignment ${randomUUID()}` },
    });

    const managerRole = await prisma.role.findUniqueOrThrow({
      where: { code: "manager" },
    });

    try {
      const targetMembership = await prisma.membership.create({
        data: {
          userId: targetUser.id,
          organizationId: organization.id,
          roleId: managerRole.id,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: assignedUser.id,
            organizationId: organization.id,
            roleId: managerRole.id,
            managerMembershipId: targetMembership.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [targetUser.id, assignedUser.id] } },
      });
    }
  });

  test("rejects a member with an admin assignment", async () => {
    const adminUser = await prisma.user.create({
      data: {
        email: `target-admin-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const memberUser = await prisma.user.create({
      data: {
        email: `assigned-member-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: { name: `Member Assignment ${randomUUID()}` },
    });

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: "admin" },
    });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: adminUser.id,
          organizationId: organization.id,
          roleId: adminRole.id,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: memberUser.id,
            organizationId: organization.id,
            roleId: memberRole.id,
            adminMembershipId: adminMembership.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [adminUser.id, memberUser.id] } },
      });
    }
  });

  test("rejects a manager assigned to another manager", async () => {
    const targetUser = await prisma.user.create({
      data: {
        email: `target-manager-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const assignedUser = await prisma.user.create({
      data: {
        email: `assigned-manager-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: { name: `Manager Role Assignment ${randomUUID()}` },
    });

    const managerRole = await prisma.role.findUniqueOrThrow({
      where: { code: "manager" },
    });

    try {
      const targetMembership = await prisma.membership.create({
        data: {
          userId: targetUser.id,
          organizationId: organization.id,
          roleId: managerRole.id,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: assignedUser.id,
            organizationId: organization.id,
            roleId: managerRole.id,
            adminMembershipId: targetMembership.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [targetUser.id, assignedUser.id] } },
      });
    }
  });

  test("rejects a member assigned to an admin as their manager", async () => {
    const adminUser = await prisma.user.create({
      data: {
        email: `target-admin-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const memberUser = await prisma.user.create({
      data: {
        email: `assigned-member-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: { name: `Member Role Assignment ${randomUUID()}` },
    });

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: "admin" },
    });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: adminUser.id,
          organizationId: organization.id,
          roleId: adminRole.id,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: memberUser.id,
            organizationId: organization.id,
            roleId: memberRole.id,
            managerMembershipId: adminMembership.id,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [adminUser.id, memberUser.id] } },
      });
    }
  });

  test("rejects changing an assigned admin membership to manager", async () => {
    const adminUser = await prisma.user.create({
      data: {
        email: `assigned-admin-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const managerUser = await prisma.user.create({
      data: {
        email: `manager-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: { name: `Admin Role Change ${randomUUID()}` },
    });

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: "admin" },
    });

    const managerRole = await prisma.role.findUniqueOrThrow({
      where: { code: "manager" },
    });

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: adminUser.id,
          organizationId: organization.id,
          roleId: adminRole.id,
        },
      });

      await prisma.membership.create({
        data: {
          userId: managerUser.id,
          organizationId: organization.id,
          roleId: managerRole.id,
          adminMembershipId: adminMembership.id,
        },
      });

      await expect(
        prisma.membership.update({
          where: { id: adminMembership.id },
          data: { roleId: managerRole.id },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [adminUser.id, managerUser.id] } },
      });
    }
  });

  test("rejects changing an assigned manager membership to admin", async () => {
    const managerUser = await prisma.user.create({
      data: {
        email: `assigned-manager-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const memberUser = await prisma.user.create({
      data: {
        email: `member-${randomUUID()}@example.com`,
        passwordHash: "hash",
      },
    });

    const organization = await prisma.organization.create({
      data: { name: `Manager Role Change ${randomUUID()}` },
    });

    const managerRole = await prisma.role.findUniqueOrThrow({
      where: { code: "manager" },
    });

    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: "admin" },
    });

    const memberRole = await prisma.role.findUniqueOrThrow({
      where: { code: "member" },
    });

    try {
      const managerMembership = await prisma.membership.create({
        data: {
          userId: managerUser.id,
          organizationId: organization.id,
          roleId: managerRole.id,
        },
      });

      await prisma.membership.create({
        data: {
          userId: memberUser.id,
          organizationId: organization.id,
          roleId: memberRole.id,
          managerMembershipId: managerMembership.id,
        },
      });

      await expect(
        prisma.membership.update({
          where: { id: managerMembership.id },
          data: { roleId: adminRole.id },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [managerUser.id, memberUser.id] } },
      });
    }
  });
});
