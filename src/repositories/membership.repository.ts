import { prisma, type DatabaseClient } from "../lib/prisma.js";

const membershipReadSelect = {
  id: true,
  organizationId: true,
  userId: true,
  roleId: true,
  adminMembershipId: true,
  managerMembershipId: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      email: true,
    },
  },
  organization: {
    select: {
      id: true,
      name: true,
    },
  },
  role: {
    select: {
      id: true,
      code: true,
      name: true,
    },
  },
  adminMembership: {
    select: {
      id: true,
      user: {
        select: {
          id: true,
          email: true,
        },
      },
      role: {
        select: {
          code: true,
          name: true,
        },
      },
    },
  },
  managerMembership: {
    select: {
      id: true,
      user: {
        select: {
          id: true,
          email: true,
        },
      },
      role: {
        select: {
          code: true,
          name: true,
        },
      },
    },
  },
} as const;

export function findMembershipById(
  id: string,
  organizationId?: string,
  db: DatabaseClient = prisma,
) {
  return db.membership.findFirst({
    where: {
      id,
      ...(organizationId ? { organizationId } : {}),
    },
    select: membershipReadSelect,
  });
}

export function findMembershipByUserAndOrganization(
  userId: string,
  organizationId: string,
  db: DatabaseClient = prisma,
) {
  return db.membership.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId,
      },
    },
    include: {
      role: {
        include: {
          rolePermissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    },
  });
}

export function findMembershipsByOrganizationId(
  organizationId: string,
  db: DatabaseClient = prisma,
) {
  return db.membership.findMany({
    where: { organizationId },
    select: membershipReadSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export function findMembershipsByUserId(
  userId: string,
  db: DatabaseClient = prisma,
) {
  return db.membership.findMany({
    where: { userId },
    select: {
      id: true,
      organizationId: true,
      role: {
        select: {
          code: true,
          name: true,
        },
      },
      organization: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });
}
