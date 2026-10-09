import { describe, expect, it } from "@jest/globals";
import request from "supertest";
import app from "../src/app.js";

describe("GET /health", () => {
  it("returns 200 and a healthy status", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
