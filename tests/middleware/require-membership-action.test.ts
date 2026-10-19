import express from "express";
import request from "supertest";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import "../../src/middleware/require-auth.js";

const mockCanPerformMembershipAction =
  jest.fn<
    (
      actorUserId: string,
      organizationId: string,
      membershipId: string,
      permissionCode: string,
    ) => Promise<boolean>
  >();

jest.unstable_mockModule("../../src/services/authorization.service.js", () => ({
  canPerformMembershipAction: mockCanPerformMembershipAction,
}));

const { requireMembershipAction } =
  await import("../../src/middleware/require-membership-action.js");

function createApp(authenticated = true) {
  const app = express();

  app.use((req, _res, next) => {
    if (authenticated) {
      req.auth = {
        user: {
          id: "actor-user-id",
          email: "actor@example.com",
          emailVerifiedAt: null,
        },
        session: {
          id: "session-id",
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        },
      };
    }

    next();
  });

  app.delete(
    "/organizations/:organizationId/memberships/:membershipId",
    requireMembershipAction("membership.remove"),
    (_req, res) => {
      res.status(204).end();
    },
  );

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred",
        },
      });
    },
  );

  return app;
}

afterEach(() => {
  mockCanPerformMembershipAction.mockReset();
});

describe("requireMembershipAction", () => {
  test("rejects unauthenticated requests", async () => {
    const response = await request(createApp(false)).delete(
      "/organizations/org-1/memberships/member-1",
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(mockCanPerformMembershipAction).not.toHaveBeenCalled();
  });

  test("rejects missing authorization context", async () => {
    const app = express();

    app.use((req, _res, next) => {
      req.auth = {
        user: {
          id: "actor-user-id",
          email: "actor@example.com",
          emailVerifiedAt: null,
        },
        session: {
          id: "session-id",
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        },
      };

      next();
    });

    app.delete(
      "/organizations/:organizationId/memberships/:membershipId",
      requireMembershipAction("membership.remove"),
      (_req, res) => res.sendStatus(204),
    );

    const response = await request(app).delete(
      "/organizations/org-1/memberships/",
    );

    // Express does not match the route when membershipId is absent.
    expect(response.status).toBe(404);
    expect(mockCanPerformMembershipAction).not.toHaveBeenCalled();
  });

  test("rejects actors without permission or administrative scope", async () => {
    mockCanPerformMembershipAction.mockResolvedValue(false);

    const response = await request(createApp()).delete(
      "/organizations/org-1/memberships/member-1",
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(mockCanPerformMembershipAction).toHaveBeenCalledWith(
      "actor-user-id",
      "org-1",
      "member-1",
      "membership.remove",
    );
  });

  test("allows an authorized actor to proceed", async () => {
    mockCanPerformMembershipAction.mockResolvedValue(true);

    const response = await request(createApp()).delete(
      "/organizations/org-1/memberships/member-1",
    );

    expect(response.status).toBe(204);
    expect(mockCanPerformMembershipAction).toHaveBeenCalledWith(
      "actor-user-id",
      "org-1",
      "member-1",
      "membership.remove",
    );
  });

  test("denies a target outside the actor's authorized scope", async () => {
    // The authorization service returns false for a target outside
    // the requested organization or the actor's administrative scope.
    mockCanPerformMembershipAction.mockResolvedValue(false);

    const response = await request(createApp()).delete(
      "/organizations/org-1/memberships/foreign-member",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "You are not authorized to perform this action",
      },
    });
  });

  test("forwards authorization service errors to error handling", async () => {
    mockCanPerformMembershipAction.mockRejectedValue(
      new Error("Database failure"),
    );

    const response = await request(createApp()).delete(
      "/organizations/org-1/memberships/member-1",
    );

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  test("rejects an empty permission code at configuration time", () => {
    expect(() => requireMembershipAction("  ")).toThrow(
      "A permission code is required",
    );
  });
});
