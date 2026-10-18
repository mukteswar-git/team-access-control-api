import type { ErrorRequestHandler } from "express";
import { AuthError } from "../modules/auth/auth.errors.js";

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AuthError) {
    const statusCodes: Record<AuthError["code"], number> = {
      EMAIL_ALREADY_EXISTS: 409,
      INVALID_CREDENTIALS: 401,
      EMAIL_NOT_VERIFIED: 403,
      INVALID_OR_EXPIRED_TOKEN: 400,
      INVALID_INPUT: 400,
    };

    res.status(statusCodes[err.code]).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });

    return;
  }

  console.error(err);

  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    },
  });
};

export default errorHandler;
