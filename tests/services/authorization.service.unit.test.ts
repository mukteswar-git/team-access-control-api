import { afterEach, describe, expect, jest, test } from "@jest/globals";

const findMembershipByUserAndOrganization =
  jest.fn<
    (userId: string, organizationId: string, db?: unknown) => Promise<unknown>
  >();

const findFirst = jest.fn<(args: unknown) => Promise<unknown>>();

jest.unstable_mockModule(
  "../../src/repositories/membership.repository.js",
  () => ({ findMembershipByUserAndOrganization }),
);

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  prisma: {
    membership: {
      findFirst,
    },
  },
}));

const {
  hasOrganizationMembership,
  hasPermission,
  canManageMembership,
  canPerformMembershipAction,
  canChangeMembershipRole,
} = await import("../../src/services/authorization.service.js");

const mockMembership = (permissions: string[] = []) => ({
  role: {
    rolePermissions: permissions.map((code) => ({
      permission: { code },
    })),
  },
});

const mockScopedMembership = ({
  id,
  role,
  adminMembershipId = null,
  managerMembershipId = null,
}: {
  id: string;
  role: string;
  adminMembershipId?: string | null;
  managerMembershipId?: string | null;
}) => ({
  id,
  role: {
    code: role,
    rolePermissions: [],
  },
  adminMembershipId,
  managerMembershipId,
});

afterEach(() => {
  jest.clearAllMocks();
});

describe("Authorization service — isolated unit tests", () => {
  test("confirms organization membership when a membership exists", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockMembership() as never,
    );

    await expect(hasOrganizationMembership("user-1", "org-1")).resolves.toBe(
      true,
    );
  });

  test("denies organization membership when no membership exists", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(null);

    await expect(hasOrganizationMembership("user-1", "org-1")).resolves.toBe(
      false,
    );
  });

  test("grants a permission assigned to the user's role", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockMembership(["organization.read"]) as never,
    );

    await expect(
      hasPermission("user-1", "org-1", "organization.read"),
    ).resolves.toBe(true);
  });

  test("denies a permission not assigned to the user's role", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockMembership(["organization.read"]) as never,
    );

    await expect(
      hasPermission("user-1", "org-1", "organization.manage"),
    ).resolves.toBe(false);
  });

  test("denies an unknown permission code", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockMembership(["organization.read"]) as never,
    );

    await expect(
      hasPermission("user-1", "org-1", "permission.unknown"),
    ).resolves.toBe(false);
  });

  test("denies permission checks when membership is missing", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(null);

    await expect(
      hasPermission("user-1", "org-1", "organization.read"),
    ).resolves.toBe(false);
  });
});

describe("canManageMembership", () => {
  test("allows a Super User to manage an Admin", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "actor-1",
        role: "super_user",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "target-1",
        role: "admin",
      }) as never,
    );

    await expect(
      canManageMembership("user-1", "org-1", "target-1"),
    ).resolves.toBe(true);
  });

  test("denies a Super User from managing another Super User", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "actor-1",
        role: "super_user",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "target-1",
        role: "super_user",
      }) as never,
    );

    await expect(
      canManageMembership("user-1", "org-1", "target-1"),
    ).resolves.toBe(false);
  });

  test("denies a Member from managing another membership", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "actor-1",
        role: "member",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "target-1",
        role: "member",
      }) as never,
    );

    await expect(
      canManageMembership("user-1", "org-1", "target-1"),
    ).resolves.toBe(false);
  });

  test("denies management when the actor has no organization membership", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(null);
    findFirst.mockResolvedValue(null);

    findFirst.mockClear();

    await expect(
      canManageMembership("user-1", "org-1", "target-1"),
    ).resolves.toBe(false);

    expect(findFirst).not.toHaveBeenCalled();
  });

  test("allows an Admin to manage a Manager assigned to them", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "manager-1",
        role: "manager",
        adminMembershipId: "admin-1",
      }) as never,
    );

    await expect(
      canManageMembership("admin-user", "org-1", "manager-1"),
    ).resolves.toBe(true);
  });

  test("denies an Admin from managing another Admin", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "admin-2",
        role: "admin",
      }) as never,
    );

    await expect(
      canManageMembership("admin-user", "org-1", "admin-2"),
    ).resolves.toBe(false);
  });

  test("denies an Admin from managing a Manager assigned to another Admin", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "manager-1",
        role: "manager",
        adminMembershipId: "admin-2",
      }) as never,
    );

    await expect(
      canManageMembership("admin-user", "org-1", "manager-1"),
    ).resolves.toBe(false);
  });

  test("allows an Admin to manage an unassigned Member", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "member-1",
        role: "member",
      }) as never,
    );

    await expect(
      canManageMembership("admin-user", "org-1", "member-1"),
    ).resolves.toBe(true);
  });

  test("allows a Manager to manage a directly assigned Member", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "manager-1",
        role: "manager",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "member-1",
        role: "member",
        managerMembershipId: "manager-1",
      }) as never,
    );

    await expect(
      canManageMembership("manager-user", "org-1", "member-1"),
    ).resolves.toBe(true);
  });

  test("denies a Manager from managing another Manager's Member", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "manager-1",
        role: "manager",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "member-1",
        role: "member",
        managerMembershipId: "manager-2",
      }) as never,
    );

    await expect(
      canManageMembership("manager-user", "org-1", "member-1"),
    ).resolves.toBe(false);
  });

  test("denies management when the target is outside the organization", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );
    findFirst.mockResolvedValue(null);

    await expect(
      canManageMembership("admin-user", "org-1", "foreign-target"),
    ).resolves.toBe(false);
  });

  test("denies management when the target does not exist", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );
    findFirst.mockResolvedValue(null);

    await expect(
      canManageMembership("admin-user", "org-1", "missing-target"),
    ).resolves.toBe(false);
  });

  test("denies self-management", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );
    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );

    await expect(
      canManageMembership("admin-user", "org-1", "admin-1"),
    ).resolves.toBe(false);
  });

  test("denies an Admin when a target Member's Manager is not assigned to that Admin", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );

    findFirst
      .mockResolvedValueOnce(
        mockScopedMembership({
          id: "member-1",
          role: "member",
          managerMembershipId: "manager-2",
        }) as never,
      )
      .mockResolvedValueOnce(null);

    await expect(
      canManageMembership("admin-user", "org-1", "member-1"),
    ).resolves.toBe(false);
  });
});

describe("canPerformMembershipAction", () => {
  test("denies an action when the actor lacks the required permission", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );

    await expect(
      canPerformMembershipAction(
        "user-1",
        "org-1",
        "target-1",
        "membership.update",
      ),
    ).resolves.toBe(false);

    expect(findFirst).not.toHaveBeenCalled();
  });

  test("denies an action when the actor cannot manage the target", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
        adminMembershipId: null,
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "target-1",
        role: "admin",
      }),
    );

    await expect(
      canPerformMembershipAction(
        "user-1",
        "org-1",
        "target-1",
        "membership.update",
      ),
    ).resolves.toBe(false);
  });

  test("allows an action when permission and target scope are valid", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue({
      ...mockScopedMembership({
        id: "super-user-1",
        role: "super_user",
      }),
      role: {
        code: "super_user",
        rolePermissions: [{ permission: { code: "membership.update" } }],
      },
    } as never);

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }),
    );

    await expect(
      canPerformMembershipAction(
        "user-1",
        "org-1",
        "target-1",
        "membership.update",
      ),
    ).resolves.toBe(true);
  });
});

describe("canChangeMembershipRole", () => {
  test("denies an unknown role code", async () => {
    await expect(
      canChangeMembershipRole("user-1", "org-1", "target-1", "owner"),
    ).resolves.toBe(false);

    expect(findMembershipByUserAndOrganization).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  test("denies changing a target from Super User to Admin", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue({
      ...mockScopedMembership({
        id: "actor-1",
        role: "super_user",
      }),
      role: {
        code: "super_user",
        rolePermissions: [{ permission: { code: "membership.update" } }],
      },
    } as never);

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "target-1",
        role: "super_user",
      }),
    );

    await expect(
      canChangeMembershipRole("actor-user-1", "org-1", "target-1", "admin"),
    ).resolves.toBe(false);
  });

  test("denies promoting a target to Super User", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue({
      ...mockScopedMembership({
        id: "actor-1",
        role: "super_user",
      }),
      role: {
        code: "super_user",
        rolePermissions: [{ permission: { code: "membership.update" } }],
      },
    } as never);

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "target-1",
        role: "admin",
      }),
    );

    await expect(
      canChangeMembershipRole(
        "actor-user-1",
        "org-1",
        "target-1",
        "super_user",
      ),
    ).resolves.toBe(false);
  });

  test("allows a Super User to change an Admin to Manager", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue({
      ...mockScopedMembership({
        id: "super-user-1",
        role: "super_user",
      }),
      role: {
        code: "super_user",
        rolePermissions: [{ permission: { code: "membership.update" } }],
      },
    } as never);

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }),
    );

    await expect(
      canChangeMembershipRole("super-user-user", "org-1", "admin-1", "manager"),
    ).resolves.toBe(true);
  });

  test("denies an Admin from promoting a Member to Admin", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue({
      ...mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }),
      role: {
        code: "admin",
        rolePermissions: [{ permission: { code: "membership.update" } }],
      },
    } as never);

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "member-1",
        role: "member",
      }),
    );

    await expect(
      canChangeMembershipRole("admin-user", "org-1", "member-1", "admin"),
    ).resolves.toBe(false);
  });

  test("denies a role change when the target already has that role", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "super-user-1",
        role: "super_user",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }),
    );

    await expect(
      canChangeMembershipRole("super-user-user", "org-1", "admin-1", "admin"),
    ).resolves.toBe(false);
  });

  test("denies changing the actor's own role", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }),
    );

    await expect(
      canChangeMembershipRole("admin-user", "org-1", "admin-1", "manager"),
    ).resolves.toBe(false);
  });

  test("denies a role change without membership.update permission", async () => {
    findMembershipByUserAndOrganization.mockResolvedValue(
      mockScopedMembership({
        id: "super-user-1",
        role: "super_user",
      }) as never,
    );

    findFirst.mockResolvedValue(
      mockScopedMembership({
        id: "admin-1",
        role: "admin",
      }),
    );

    await expect(
      canChangeMembershipRole("super-user-user", "org-1", "admin-1", "manager"),
    ).resolves.toBe(false);
  });
});
