import type { Request, Response, NextFunction } from "express";
import {
  createInvitation,
  revokeInvitation,
  acceptInvitation,
} from "../../services/invitation.service.js";

export async function createInvitationController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const actorUserId = req.auth!.user.id;
    const organizationId = req.params.organizationId as string;

    const result = await createInvitation(
      actorUserId,
      organizationId,
      req.body,
    );

    res.status(201).json({
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function revokeInvitationController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const actorUserId = req.auth!.user.id;
    const organizationId = req.params.organizationId as string;
    const invitationId = req.params.invitationId as string;

    const result = await revokeInvitation(
      actorUserId,
      organizationId,
      invitationId,
    );

    res.status(200).json({
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function acceptInvitationController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = req.auth!.user.id;
    const { token } = req.body;

    const result = await acceptInvitation(userId, token);

    res.status(200).json({
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
