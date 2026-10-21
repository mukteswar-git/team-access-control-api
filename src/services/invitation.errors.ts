export type InvitationErrorCode =
  | "INVALID_INPUT"
  | "FORBIDDEN"
  | "ORGANIZATION_NOT_FOUND"
  | "INVITATION_NOT_FOUND"
  | "INVALID_INVITATION_STATE"
  | "ROLE_NOT_FOUND"
  | "INVALID_ASSIGNMENT"
  | "PENDING_INVITATION_EXISTS"
  | "EMAIL_NOT_VERIFIED"
  | "EMAIL_MISMATCH"
  | "ALREADY_MEMBER";

export class InvitationError extends Error {
  constructor(
    public readonly code: InvitationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InvitationError";
  }
}
