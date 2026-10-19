import express from "express";
import request from "supertest";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import "../../src/middleware/require-auth.js";

const mockHasOrganizationMembership =
  jest.fn<(userId: string, organizationId: string) => Promise<boolean>>();

jest.unstable_mockModule("../../src/services/authorization.service.js", () => ({
  hasOrganizationMembership: mockHasOrganizationMembership,
}));

const { requireOrganizationMembership } =
  await import("../../src/middleware/require-organization-membership.js");

function createApp(authenticated = true) {
  const app = express();

  // Test-only middleware to simulate the identity established by requireAuth.
  app.use((req, _res, next) => {
    if (authenticated) {
      req.auth = {
        user: {
          id: "user-123",
          email: "user@example.com",
          emailVerifiedAt: new Date(),
        },
        session: {
          id: "session-123",
          expiresAt: new Date(Date.now() + 60_000),
        },
      };
    }

    next();
  });

  app.get(
    "/organizations/:organizationId",
    requireOrganizationMembership,
    (_req, res) => {
      res.status(200).json({ status: "ok" });
    },
  );

  app.use(
    (
      err: Error,
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
  mockHasOrganizationMembership.mockReset();
});

describe("requireOrganizationMembership middleware", () => {
  test("rejects requests without authentication", async () => {
    const response = await request(createApp(false)).get(
      "/organizations/org-123",
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(mockHasOrganizationMembership).not.toHaveBeenCalled();
  });

  test("rejects a missing organization ID", async () => {
    const response = await request(createApp()).get("/organizations/");

    expect(response.status).toBe(404);
    expect(mockHasOrganizationMembership).not.toHaveBeenCalled();
  });

  test("rejects users without organization membership", async () => {
    mockHasOrganizationMembership.mockResolvedValue(false);

    const response = await request(createApp()).get("/organizations/org-123");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(mockHasOrganizationMembership).toHaveBeenCalledWith(
      "user-123",
      "org-123",
    );
  });

  test("allows users with organization membership", async () => {
    mockHasOrganizationMembership.mockResolvedValue(true);

    const response = await request(createApp()).get("/organizations/org-123");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(mockHasOrganizationMembership).toHaveBeenCalledWith(
      "user-123",
      "org-123",
    );
  });

  test("forwards unexpected authorization service errors", async () => {
    mockHasOrganizationMembership.mockRejectedValue(
      new Error("Database unavailable"),
    );

    const response = await request(createApp()).get("/organizations/org-123");

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
