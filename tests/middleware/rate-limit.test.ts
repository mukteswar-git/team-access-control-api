import { describe, expect, it } from "@jest/globals";
import express from "express";
import request from "supertest";
import { rateLimit } from "express-rate-limit";

describe("Rate-limit middleware", () => {
  it("returns 429 after the configured request limit", async () => {
    const app = express();

    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 2,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: {
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests. Please try again later.",
          },
        },
      }),
    );

    app.get("/test", (_req, res) => {
      res.status(200).json({ success: true });
    });

    const first = await request(app).get("/test");
    const second = await request(app).get("/test");
    const third = await request(app).get("/test");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});
