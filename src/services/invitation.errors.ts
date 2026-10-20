export type InvitationErrorCode =
  | "INVALID_INPUT"
  | "FORBIDDEN"
  | "ORGANIZATION_NOT_FOUND"
  | "ROLE_NOT_FOUND"
  | "INVALID_ASSIGNMENT"
  | "PENDING_INVITATION_EXISTS";

export class InvitationError extends Error {
  constructor(
    public readonly code: InvitationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InvitationError";
  }
}
