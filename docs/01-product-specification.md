# Product & Authorization Specification

## Table of Contents

- [1. Purpose and scope](#1-purpose-and-scope)
- [2. Goals](#2-goals)
- [3. Non-goals for the initial release](#3-non-goals-for-the-initial-release)
- [4. Core terms](#4-core-terms)
- [5. Product model](#5-product-model)
  - [5.1 User and account rules](#51-user-and-account-rules)
  - [5.2 Organization creation and ownership](#52-organization-creation-and-ownership)
- [6. Memberships and reporting relationships](#6-memberships-and-reporting-relationships)
- [7. Role hierarchy](#7-role-hierarchy)
- [8. Permission catalog and authorization matrix](#8-permission-catalog-and-authorization-matrix)
  - [8.1 Permission meanings](#81-permission-meanings)
  - [8.2 Organization-role matrix](#82-organization-role-matrix)
  - [8.3 Scope rules for the authorization matrix](#83-scope-rules-for-the-authorization-matrix)
  - [8.4 Visibility rules](#84-visibility-rules)
  - [8.5 Unassigned resources](#85-unassigned-resources)
  - [8.6 Ownership and Super User rules](#86-ownership-and-super-user-rules)
  - [8.7 Authorization principle](#87-authorization-principle)
- [9. Scope rules](#9-scope-rules)
  - [9.1 Super User scope](#91-super-user-scope)
  - [9.2 Admin scope](#92-admin-scope)
  - [9.3 Manager scope](#93-manager-scope)
  - [9.4 Scope changes](#94-scope-changes)
  - [9.5 Scope is evaluated at the time of the action](#95-scope-is-evaluated-at-the-time-of-the-action)
  - [9.6 Scope and visibility are separate](#96-scope-and-visibility-are-separate)
- [10. Invitations and onboarding](#10-invitations-and-onboarding)
  - [10.1 Invitation creation and assignment](#101-invitation-creation-and-assignment)
  - [10.2 Invitation states](#102-invitation-states)
  - [10.3 Recipient flow](#103-recipient-flow)
  - [10.4 Predefined email templates](#104-predefined-email-templates)
- [11. Authentication and session management](#11-authentication-and-session-management)
  - [11.1 Initial authentication scope](#111-initial-authentication-scope)
  - [11.2 Session rules](#112-session-rules)
  - [11.3 Authentication versus authorization](#113-authentication-versus-authorization)
  - [11.4 Logout and session revocation](#114-logout-and-session-revocation)
  - [11.5 Password recovery](#115-password-recovery)
- [12. Audit logging](#12-audit-logging)
  - [12.1 Purpose and access](#121-purpose-and-access)
  - [12.2 Required event content](#122-required-event-content)
  - [12.3 Events to record](#123-events-to-record)
- [13. Authorization decision flow](#13-authorization-decision-flow)
- [14. Cross-organization isolation](#14-cross-organization-isolation)
- [15. Business rules and edge cases](#15-business-rules-and-edge-cases)
- [16. Security requirements](#16-security-requirements)
  - [16.1 Transport and session security](#161-transport-and-session-security)
  - [16.2 Password and credential security](#162-password-and-credential-security)
  - [16.3 Email and invitation security](#163-email-and-invitation-security)
  - [16.4 Rate limiting and abuse protection](#164-rate-limiting-and-abuse-protection)
  - [16.5 Input and data-access security](#165-input-and-data-access-security)
  - [16.6 Multi-tenant isolation](#166-multi-tenant-isolation)
  - [16.7 Authorization security](#167-authorization-security)
  - [16.8 Audit security](#168-audit-security)
  - [16.9 Sensitive operations](#169-sensitive-operations)
- [17. Acceptance criteria](#17-acceptance-criteria)
- [18. Future extensions and deferred artifacts](#18-future-extensions-and-deferred-artifacts)
  - [18.1 TOTP-based two-factor authentication](#181-totp-based-two-factor-authentication)
  - [18.2 Deferred implementation artifacts](#182-deferred-implementation-artifacts)
  - [18.3 Future product capabilities](#183-future-product-capabilities)
- [19. Implementation principle](#19-implementation-principle)

## 1. Purpose and scope

This product is an identity and access management (IAM) backend for a multi-tenant SaaS application. It enables people to create accounts, create or join organizations, invite teammates, assign organization-specific roles, control access to sensitive operations, manage authenticated sessions, and review security-relevant activity.

The central rule is that access belongs to an **organization membership**, not to a user globally. The same person may belong to several organizations and hold a different role in each one. Data and actions in one organization must never be accessible merely because the person belongs to another.

The initial release uses four fixed roles—**Super User**, **Admin**, **Manager**, and **Member**—and organization-scoped administrative relationships. Role-based access control (RBAC) determines whether an actor has a capability; resource scope determines whether that capability may affect a particular target. An Admin’s scope consists of its assigned Managers and the Members assigned to those Managers. A Manager’s scope consists only of directly assigned Members.

This document defines product behavior and authorization requirements. Database schema and API specifications are deliberately future artifacts and must conform to these rules.

## 2. Goals

- Provide secure account registration, email verification, login, logout, password recovery, and session management.
- Support multiple isolated organizations per user, with a role evaluated separately in each organization.
- Make membership administration and reporting assignments explicit, predictable, and traceable.
- Enforce the role hierarchy and administrative scope consistently for every protected action.
- Support invitation-led onboarding for both existing and new users.
- Record an immutable, organization-scoped history of sensitive activity.
- Make authorization decisions explainable: authenticated identity, organization, membership, permission, target scope, then allow or deny.

## 3. Non-goals for the initial release

- Database design, migrations, ORM models, and query design.
- Endpoint-by-endpoint API contract or transport choices.
- Enterprise SSO, SCIM provisioning, external identity-provider federation, or directory synchronization.
- Custom roles, arbitrary permission editing, groups, teams, or delegation beyond the four defined roles and administrative relationships.
- SMS-based multi-factor authentication.
- Billing, subscription management, or organization discovery/public directories.

## 4. Core terms

| Term                 | Meaning                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| User                 | A person with one global application account, identified by a verified email address.                                             |
| Organization         | An isolated tenant/workspace containing memberships, invitations, and organization audit events.                                  |
| Membership           | A user’s relationship to one organization, defining their role and, when applicable, its assigned Admin or Manager.               |
| Role                 | A fixed bundle of organization permissions. A role is never global to the user.                                                   |
| Permission           | A named capability checked before an action is performed.                                                                         |
| Scope                | A second authorization check that decides whether a permitted action may affect a particular resource.                            |
| Administrative scope | The Manager and Member memberships an Admin may administer, as determined by the Managers assigned to that Admin.                 |
| Invitation           | A time-limited, single-use offer for one email address to join one organization with one role and permitted reporting assignment. |
| Session              | A current authenticated login on a browser or device.                                                                             |
| Audit log            | An append-only historical record of a security-sensitive event or important authorization denial.                                 |

## 5. Product model

```text
User
 ├─ Membership in Organization A → Super User
 ├─ Membership in Organization B → Manager
 └─ Membership in Organization C → Member

Membership → Role → Permission → Resource scope → Allow or deny
```

### 5.1 User and account rules

- A person has one account per verified email address.
- An account is global; memberships are organization-specific.
- Any verified, authenticated user may create an organization. This is an **account-level capability**, not an organization-role permission.
- A user can belong to any number of organizations, subject to future product limits.
- A user may have a different role in every organization.
- Email verification is required before the account can accept an invitation or access authenticated organization functionality.

### 5.2 Organization creation and ownership

When a verified user creates an organization, the system creates the organization and an initial membership for that user in one successful operation. The creator becomes that organization’s **Super User (Owner)**.

“Owner” is the product label for the initial and highest-privilege Super User; its authorization behavior is the Super User behavior defined below. An organization can have only one Super User. Ownership may be transferred only by a Super User to an existing organization member. The system must always retain at least one Super User.

## 6. Memberships and reporting relationships

A membership links one User to one Organization and holds the user’s role in that organization. A membership is unique for a `(user, organization)` pair: the same user cannot join the same organization twice.

The administrative hierarchy is organization-scoped:

```
Organization
└── Super User (Owner) — organization-wide authority
    ├── Admin A
    │   ├── Manager A1
    │   │   ├── Member A1-1
    │   │   └── Member A1-2
    │   └── Manager A2
    │       └── Member A2-1
    └── Admin B
        ├── Manager B1
        │   └── Member B1-1
        └── Manager B2
            └── Member B2-1
```

- An organization has exactly one Super User (Owner) and may have multiple Admins, Managers, and Members.
- Each Manager is assigned to zero or one Admin within the same organization. A Manager assigned to an Admin is within that Admin’s administrative scope.
- Each Member is assigned to zero or one Manager within the same organization. A Member assigned to a Manager is within that Manager’s scope and within the assigned Admin’s scope, if that Manager has an Admin.
- Only a Manager may be assigned to an Admin, and only a Member may be assigned to a Manager in this release.
- The Super User sits above all administrative scopes and has organization-wide scope.
- Admins, Managers, and the Super User do not report to a Manager. Admins do not report to other Admins in this release.
- Assignments are optional at creation. An unassigned Manager is in no Admin’s scope; an unassigned Member is in no Manager’s scope. Only the Super User may manage an unassigned Manager; the Super User and Admins may manage an unassigned Member as permitted below.
- Reporting assignments are independent in each organization. An assignment in one organization gives no access in another.

The hierarchy defines **administrative scope**, not merely role inheritance. Equal roles do not grant authority over one another.

## 7. Role hierarchy

Roles are fixed system roles in the initial release, ordered by administrative authority:

1. **Super User (Owner)** — the organization's sole highest-privilege role. The Super User has organization-wide authority and may administer all other memberships, including Admins, Managers, and Members. The Super User may transfer ownership to an eligible existing organization member, subject to the ownership-transfer rules.

2. **Admin** — administers Managers assigned to that Admin and the Members managed by those Managers. An Admin cannot administer the Super User, another Admin, or Managers and Members outside the Admin's administrative scope.

3. **Manager** — administers only Members directly assigned to that Manager. A Manager cannot administer Members assigned to another Manager, unassigned Members, or any Manager, Admin, or Super User.

4. **Member** — participates in the organization with no membership-management capability.

Role names alone are not sufficient for authorization. The system must check the required permission and, where applicable, the target resource's organization, role, and reporting relationship.

## 8. Permission catalog and authorization matrix

### 8.1 Permission meanings

Permissions define the capabilities available to a role. A permission alone does not determine whether an action is allowed; where applicable, the system must also evaluate the actor's organization membership, administrative scope, and relationship to the target resource.

| Permission            | Meaning                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `organization.read`   | View basic organization information.                                                                                 |
| `membership.read`     | View organization members, Admins, Managers, Members, and reporting relationships permitted by the visibility rules. |
| `invitation.create`   | Create an invitation for an allowed target role and, where applicable, an allowed reporting assignment.              |
| `invitation.revoke`   | Revoke an invitation within the actor's permitted target scope.                                                      |
| `membership.update`   | Change a target membership's role or valid reporting assignment within the actor's permitted scope.                  |
| `membership.remove`   | Remove a target membership within the actor's permitted scope.                                                       |
| `organization.manage` | Update organization settings and transfer ownership.                                                                 |
| `audit_log.read`      | View organization audit events when the actor is authorized to do so.                                                |
| `session.manage_self` | View and revoke the actor's own sessions.                                                                            |
| `session.manage_any`  | Revoke another user's sessions when that user is within the actor's permitted administrative scope.                  |

### 8.2 Organization-role matrix

Organization creation is intentionally absent from this matrix. Any verified, authenticated account may create a new organization. The creator becomes the organization's initial Super User (Owner).

There is exactly one Super User per organization. The Super User has organization-wide administrative scope.

Admins have administrative scope over the Managers assigned to them and the Members managed by those Managers. Admins may also manage unassigned Members.

Managers have administrative scope only over Members directly assigned to them.

Members have no membership-management authority.

| **Action**                                             | **Super User**                                              | **Admin**                                                             | **Manager**                                     | **Member** |
| ------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- | ---------- |
| View organization and members                          | Yes                                                         | Yes                                                                   | Yes                                             | Yes        |
| View Admins, Managers, reporting structure, and counts | Yes                                                         | Yes                                                                   | Yes                                             | Yes        |
| Update organization settings                           | Yes                                                         | No                                                                    | No                                              | No         |
| Transfer ownership                                     | Yes                                                         | No                                                                    | No                                              | No         |
| Invite Admin                                           | Yes                                                         | No                                                                    | No                                              | No         |
| Invite Manager                                         | Yes; may assign to any Admin or leave unassigned            | Yes; automatically assigned to inviting Admin                         | No                                              | No         |
| Invite Member                                          | Yes; may assign to any eligible Manager or leave unassigned | Yes; may assign to a Manager within own scope or leave unassigned     | Yes; automatically assigned to inviting Manager | No         |
| Revoke invitation                                      | Any target role                                             | Manager/Member invitations within own scope                           | Member invitations created by the Manager       | No         |
| Change Admin role                                      | Yes                                                         | No                                                                    | No                                              | No         |
| Change Manager role                                    | Yes                                                         | Own-scope Managers; may demote to Member only                         | No                                              | No         |
| Change Manager Admin assignment                        | Yes                                                         | No                                                                    | No                                              | No         |
| Change Member role                                     | Yes                                                         | Own-scope Members and unassigned Members; may promote to Manager only | No                                              | No         |
| Change Member Manager assignment                       | Yes                                                         | Own-scope Members and unassigned Members                              | No                                              | No         |
| Remove Admin                                           | Yes                                                         | No                                                                    | No                                              | No         |
| Remove Manager                                         | Yes                                                         | Own-scope Managers only                                               | No                                              | No         |
| Remove Member                                          | Yes                                                         | Own-scope Members and unassigned Members                              | Direct Members only                             | No         |
| View organization audit logs                           | Yes                                                         | Yes                                                                   | No                                              | No         |
| Revoke own sessions                                    | Yes                                                         | Yes                                                                   | Yes                                             | Yes        |
| Revoke another user's sessions                         | Yes; any organization member                                | Own-scope Managers, Members, and unassigned Members                   | Direct Members only                             | No         |

### 8.3 Scope rules for the authorization matrix

The matrix above defines the maximum authority available to each role. A `Yes` does not mean that the actor can perform the action against every resource in the organization.

#### Super User scope

The Super User has organization-wide administrative scope.

The Super User may:

- Manage Admins.
- Manage Managers.
- Manage Members.
- Manage unassigned Managers and Members.
- Assign Managers to any Admin.
- Assign Members to any eligible Manager or leave them unassigned.
- Transfer ownership to an eligible existing organization member.

The Super User cannot create a second Super User. Ownership transfer changes the organization's single Super User.

#### Admin scope

Each Admin has an independent administrative scope.

An Admin's scope consists of:

1. Managers assigned to that Admin.
2. Members assigned to those Managers.
3. Unassigned Members.

For example:

```
Organization
│
├── Owner / Super User
│
├── Admin A
│   ├── Manager A1
│   │   ├── Member 1
│   │   └── Member 2
│   └── Manager A2
│       └── Member 3
│
└── Admin B
    ├── Manager B1
    │   ├── Member 4
    │   └── Member 5
    └── Manager B2
        └── Member 6
```

Admin A may manage:

```
Manager A1
Manager A2
Member 1
Member 2
Member 3
Unassigned Members
```

Admin A may not manage:

```
Admin B
Manager B1
Manager B2
Member 4
Member 5
Member 6
```

An Admin may not modify, remove, reassign, or otherwise administer another Admin's Managers or Members.

#### Manager scope

A Manager's scope consists only of Members directly assigned to that Manager.

For example:

```
Manager A1
├── Member 1
└── Member 2
```

Manager A1 may:

- View Member 1 and Member 2.
- Invite new Members assigned to Manager A1.
- Update permitted attributes of Member 1 and Member 2.
- Remove Member 1 and Member 2.

Manager A1 may not:

- Manage Manager A2.
- Manage Admin A.
- Manage the Super User.
- Manage Members assigned to Manager A2.
- Manage Members assigned to another Admin.
- Manage unassigned Members.
- Assign a Member to another Manager.
- Promote a Member to Manager, Admin, or Super User.

### 8.4 Visibility rules

Visibility and management authority are separate concepts.

All organization members may view:

- Basic organization information.
- The organization's member directory.
- The list of Admins.
- The list of Managers.
- Each Manager's assigned Member count.
- Visible reporting relationships showing which Manager is assigned to which Members.
- The organizational structure necessary to understand who reports to whom.

This visibility does not grant permission to modify, remove, invite, reassign, or otherwise administer those resources.

For example:

```
Admin A
```

may see:

```
Admin B
├── Manager B1 → 2 Members
└── Manager B2 → 1 Member
```

but Admin A cannot:

```
Change Manager B1
Remove Manager B1
Reassign Manager B1
Remove Member 4
Reassign Member 4
Invite a Member under Manager B1
```

Similarly, Manager A may see:

```
Manager B → 3 Members
```

but cannot manage Manager B or any of B's Members.

### 8.5 Unassigned resources

A Manager must always have an assigned Admin or remain explicitly unassigned.

A Member may be assigned to a Manager or remain explicitly unassigned.

An unassigned Manager is outside every Admin's scope and may be managed only by the Super User.

An unassigned Member is not within any Manager's scope. The Super User and all Admins may manage an unassigned Member.

Once an unassigned Member is assigned to a Manager, that Member becomes part of that Manager's scope and, consequently, the scope of the Admin responsible for that Manager.

### 8.6 Ownership and Super User rules

Each organization has exactly one Super User, who is also the Owner.

The current Super User cannot be directly removed or demoted. To cease being the Super User, ownership must first be transferred to an eligible existing organization member.

Ownership can be transferred only by the current Super User to an existing organization member who is eligible to become the new Super User.

Upon successful ownership transfer, the previous Super User becomes an Admin and the target existing organization member becomes the new Super User/Owner.

A successful ownership transfer must result in:

```
Before:
Owner → Super User
Member X → Member

After:
Owner → Admin
Member X → Super User / Owner
```

The organization must never have zero or more than one Super User.

Ownership transfer must be performed atomically and recorded in the audit log.

### 8.7 Authorization principle

The system must evaluate authorization using both **permission** and **scope**.

For example:

```
Manager A
    │
    ├── Has membership.remove permission
    │
    └── Target = Member 3
              │
              ├── Member 3 assigned to Manager A → Allow
              │
              └── Member 3 assigned to Manager B → Deny
```

Therefore:

> Having a permission does not automatically grant organization-wide access to the corresponding resource.

Every protected operation must verify:

1. The user is authenticated.
2. The user has an active membership in the target organization.
3. The user's role provides the required permission.
4. The target resource belongs to the same organization.
5. The target resource falls within the actor's administrative scope.
6. Any role-specific hierarchy and reporting rules are satisfied.

If any required condition fails, the action must be denied.

## 9. Scope rules

Permissions determine **what type of action** a role may perform. Scope determines **which organization resources** that action may affect. Both permission and scope must be satisfied before a protected action is allowed.

### 9.1 Super User scope

The Super User has organization-wide scope over all memberships, invitations, and organization resources, subject to the explicit rules and invariants defined in this specification.

The Super User may:

- Manage Admins, Managers, and Members.
- Assign a Manager to any Admin.
- Move a Manager from one Admin to another Admin.
- Remove a Manager's Admin assignment, leaving the Manager unassigned.
- Assign a Member to any eligible Manager.
- Move a Member from one Manager to another Manager.
- Remove a Member's Manager assignment, leaving the Member unassigned.
- Manage unassigned Managers and Members.
- Transfer ownership to an eligible existing organization member.

The Super User cannot create a second Super User. Ownership transfer changes the organization's single Super User.

### 9.2 Admin scope

An Admin's administrative scope consists of:

1. Managers assigned to that Admin.
2. Members directly assigned to those Managers.
3. Unassigned Members.

An Admin's scope does not include:

- The Super User.
- Other Admins.
- Managers assigned to another Admin.
- Members assigned to another Admin's Managers.
- Unassigned Managers.

For example:

```
Organization
│
├── Super User
│
├── Admin A
│   ├── Manager A1
│   │   ├── Member 1
│   │   └── Member 2
│   └── Manager A2
│       └── Member 3
│
├── Admin B
│   └── Manager B1
│       └── Member 4
│
└── Unassigned Manager
```

Admin A may manage:

```
Manager A1
Manager A2
Member 1
Member 2
Member 3
Unassigned Members
```

Admin A may not manage:

```
Admin B
Manager B1
Member 4
Unassigned Manager
Super User
```

An Admin may:

- Invite a Manager only when the resulting Manager is assigned to that Admin.
- Invite a Member and assign the Member to a Manager within the Admin's scope or leave the Member unassigned.
- Update or remove Managers within the Admin's scope.
- Update or remove Members within the Admin's scope or unassigned Members.
- Reassign a Member between Managers within the Admin's own scope.
- Remove a Member's Manager assignment, making the Member unassigned.
- Revoke invitations within the Admin's permitted scope.

An Admin cannot:

- Edit, remove, or reassign another Admin.
- Manage another Admin's Managers or Members.
- Move a Manager into or out of another Admin's scope.
- Move a Member into or out of another Admin's scope.
- Manage an unassigned Manager.
- Promote a Manager to Admin or Super User.
- Promote a Member to Super User.
- Assign a Manager to another Admin.

Only the Super User may change the administrative ownership of a Manager between Admin scopes.

### 9.3 Manager scope

A Manager's administrative scope consists only of Members directly assigned to that Manager.

For example:

```
Manager A1
├── Member 1
├── Member 2
└── Member 3
```

Manager A1 may:

- View Member 1, Member 2, and Member 3.
- Invite Members who will be assigned to Manager A1.
- Update permitted attributes of directly assigned Members.
- Remove directly assigned Members.
- Revoke invitations created by the Manager for Members within the Manager's scope.

Manager A1 cannot:

- Manage another Manager.
- Manage an Admin.
- Manage the Super User.
- Manage an unassigned Member.
- Manage a Member assigned to another Manager.
- Manage a Member assigned to another Admin.
- Adopt or claim an unassigned Member.
- Assign a Member to another Manager.
- Remove a Member's Manager assignment.
- Alter an Admin-to-Manager assignment.
- Promote a Member to Manager, Admin, or Super User.

A Manager may not expand their own scope. Their scope is determined exclusively by the Members currently assigned to them.

### 9.4 Scope changes

Changes to administrative scope must themselves be authorized.

For example:

```
Before:

Super User
├── Admin A
│   └── Manager A1
│       └── Member 1
│
└── Admin B
    └── Manager B1
```

The Super User may move Manager A1:

```
Admin A
    ↓
Manager A1
```

to:

```
Admin B
    ↓
Manager A1
```

After the move, Manager A1 and all Members directly assigned to Manager A1 become part of Admin B's scope.

Similarly, if the Super User removes Manager A1's Admin assignment:

```
Admin A
    ↓
Manager A1
```

becomes:

```
Super User
    ↓
Unassigned Manager A1
```

Manager A1 is then outside every Admin's scope and can be managed only by the Super User until assigned to an Admin.

A Member moved from one Manager to another similarly changes the administrative scope of that Member.

### 9.5 Scope is evaluated at the time of the action

The system must evaluate the actor's current role, organization membership, and resource scope when the action is performed.

A previously valid relationship does not permanently grant authorization.

For example, if Manager A previously managed Member 1 but Member 1 is reassigned to Manager B:

```
Before:
Manager A → Member 1

After:
Manager B → Member 1
```

Manager A immediately loses management authority over Member 1.

Similarly, if Manager A is moved from Admin A to Admin B, Admin A immediately loses administrative authority over Manager A and Manager A's Members, while Admin B gains that scope.

### 9.6 Scope and visibility are separate

A user may have visibility into resources that they cannot administer.

For example:

```
Admin A
   ↓
Can see:
Admin B
Manager B1
Member 4
```

but:

```
Admin A
   ↓
Cannot modify:
Admin B
Manager B1
Member 4
```

Therefore, `membership.read` does not imply `membership.update` or `membership.remove`.

The same principle applies to Managers: a Manager may see other Managers and their Member counts but cannot manage resources outside their own scope.

## 10. Invitations and onboarding

### 10.1 Invitation creation and assignment

An authorized inviter supplies an email address, an allowed target role, and any required reporting assignment. Before acceptance, the recipient must be shown the organization and offered role. Where a reporting assignment applies, the assigned Admin or Manager may also be displayed. The recipient cannot choose, modify, or elevate the offered role or reporting assignment.

- A Super User may invite any **lower-level role**: Admin, Manager, or Member. A Super User cannot invite another Super User.
  - A Manager invitation may be assigned to any Admin or left unassigned.
  - A Member invitation may be assigned to any eligible Manager or left unassigned.
- An Admin may invite a Manager only into that Admin's own scope. The resulting Manager is assigned to the inviting Admin.
- An Admin may invite a Member and assign the Member to a Manager within that Admin's scope or leave the Member unassigned.
- A Manager may invite only a Member. The resulting Member must be assigned to the inviting Manager.
- A Member cannot create invitations.
  An invitation is bound to its normalized recipient email, organization, offered role, and permitted reporting assignment. It uses a cryptographically strong, opaque, single-use token and expires **seven calendar days** after it is issued.

An invitation must not create a duplicate organization membership. If the recipient is already a member of the organization, the invitation cannot be used to create a second membership or change the existing membership's role or reporting assignment.

### 10.2 Invitation states

| State      | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `pending`  | Valid and awaiting acceptance.                                       |
| `accepted` | The invitation was successfully accepted; it cannot be used again.   |
| `expired`  | The seven-day validity period has passed; it cannot be accepted.     |
| `revoked`  | An authorized actor cancelled the invitation; it cannot be accepted. |

Expired invitations may be marked lazily when viewed or during scheduled cleanup, but they must be treated as expired as soon as the current time passes the expiry timestamp.

### 10.3 Recipient flow

```
Invitation email
       ↓
Recipient opens invitation
       ↓
View organization + offered role
       ↓
Does an account exist?
       /             \
     Yes              No
      ↓                ↓
   Sign in         Create account
      \                /
       ↓              ↓
       Verify invited email
              ↓
       Email verified?
              ↓
       Validate invitation
              ↓
       Validate current role
       and reporting assignment
              ↓
       Already a member?
          /          \
        Yes           No
         ↓             ↓
 Close invitation   Create membership
 without changes          ↓
         \               /
          └───────┬─────┘
                  ↓
             Invitation
               closed
```

- If the recipient already has an account, they must authenticate before accepting.
- If no account exists, the recipient creates an account using the invited email address, verifies that email, and then accepts the invitation.
- The authenticated account's verified email must exactly match the invitation's normalized recipient email. A different account must be rejected.
- The invitation's organization, offered role, and reporting assignment must be revalidated at acceptance time against the organization's current state and authorization rules.
- Acceptance must not broaden the inviter's authority. A role or assignment that is no longer valid under current organization rules must be rejected.
- If the recipient already has a membership in the organization, acceptance must not create a duplicate membership or modify the existing membership. The invitation is closed without changing the user's existing role or reporting assignment.
- A revoked, expired, or accepted invitation cannot be restored or reused. A new invitation must be issued when appropriate.

### 10.4 Predefined email templates

The mail sender and base application URL are deployment configuration. The templates below are product copy; implementation may safely substitute values and encode URLs.

**New invitation**

```
Subject: You're invited to join {{organization_name}} as {{offered_role}}

Hello,

{{inviter_name}} invited you to join {{organization_name}} as a {{offered_role}}.

This invitation expires on {{expires_at}}.

Accept invitation: {{accept_invitation_url}}

If you do not have an account, you can create one after opening the link. You must use this email address to accept.

If you were not expecting this invitation, you can ignore this email.
```

**Invitation reminder**

```
Subject: Reminder: your invitation to {{organization_name}} expires {{expires_at}}

Hello,

You have a pending invitation to join {{organization_name}} as a {{offered_role}}. It expires on {{expires_at}}.

Accept invitation: {{accept_invitation_url}}
```

**Invitation revoked**

```
Subject: Invitation to {{organization_name}} revoked

Hello,

The invitation to join {{organization_name}} as a {{offered_role}} has been revoked. The invitation link can no longer be used.

If you believe this is unexpected, contact an administrator of {{organization_name}}.
```

## 11. Authentication and session management

### 11.1 Initial authentication scope

The initial release includes:

- Account registration and email verification.
- Password hashing using **Argon2id**. Plaintext passwords must never be stored or logged.
- Login and logout.
- Secure, server-managed sessions delivered through `Secure`, `HttpOnly` cookies with an appropriate `SameSite` policy.
- Password change and forgot-password/reset flow.
- Session expiration and individual session revocation.
- "Log out everywhere" functionality.
- Login rate limiting and basic brute-force protections.

Authentication proves **who the user is**. It does not determine what the user may do inside an organization; authorization determines that.

Creating an account does not automatically create an organization. A verified user may explicitly create an organization and becomes its initial Super User (Owner).

### 11.2 Session rules

- A user may have multiple concurrent sessions across different devices and browsers.
- Every protected request must be associated with a valid, unexpired, and unrevoked session.
- A session represents one authenticated login and must have its own unique server-side identifier.
- Logging out revokes the current session.
- A user may view and revoke any of their own sessions, including sessions on other devices.
- Revoking a session must cause subsequent requests using that session to be rejected.
- "Log out everywhere" revokes all active sessions belonging to the user, including the current session.
- Password reset and password change must revoke all existing sessions. The user must authenticate again after the password change or reset.
- Session tokens must be generated using cryptographically secure randomness.
- Raw session tokens must never be logged or stored in audit metadata. Where practical, the server should store a secure hash of the token rather than the raw token.
- Sensitive authentication and session-management events must be recorded in the appropriate security or audit log.

### 11.3 Authentication versus authorization

Authentication and authorization are separate security decisions.

```
Authentication
      ↓
Who is this user?
      ↓
Valid session?
      ↓
Authenticated user
      ↓
Authorization
      ↓
Which organization?
      ↓
Which membership?
      ↓
Which role?
      ↓
Which permission?
      ↓
Which resource scope?
      ↓
Allow / Deny
```

A valid session does not grant access to every organization or every resource.

A user who belongs to multiple organizations must be authorized separately within each organization.

For example:

```
User
├── Organization A → Admin
├── Organization B → Manager
└── Organization C → Member
```

The user's session authenticates the same global account, but each organization-scoped request must independently evaluate the corresponding membership, role, permission, and resource scope.

### 11.4 Logout and session revocation

The system must distinguish between:

- **Logout:** revoke the current session.
- **Revoke session:** invalidate one selected session.
- **Log out everywhere:** invalidate all active sessions belonging to the user.

Revoking one session must not revoke the user's other sessions unless the user explicitly chooses "log out everywhere" or a security-sensitive event requires all sessions to be invalidated.

### 11.5 Password recovery

The forgot-password flow must:

- Generate a cryptographically secure, single-use reset token.
- Associate the token with the intended user account.
- Apply an appropriate expiration period.
- Never expose whether an arbitrary email address has an account through distinguishable responses.
- Never store or log the raw reset token where avoidable.
- Invalidate the token after successful use.
- Revoke all existing sessions after a successful password reset.

## 12. Audit logging

### 12.1 Purpose and access

Audit logs answer:

> **Who did what, to whom, in which organization, when, and with what result?**

Audit records are append-only. No product role may edit or delete audit records.

Only the **Super User and Admins** can view an organization's audit logs. Managers and Members cannot view organization audit logs.

Audit records must be scoped to the organization in which the event occurred. A user who belongs to multiple organizations must not gain access to one organization's audit records merely because they have a membership in another organization.

Account-level security events, such as login failures, may be recorded separately from organization audit events. Their visibility may be restricted to the affected user and authorized operational staff in a future design.

### 12.2 Required event content

Each audit record must include, when applicable:

- timestamp;
- organization identifier;
- actor user and actor membership;
- action name;
- target user, membership, session, invitation, or organization;
- result (`success` or `denied`);
- denial reason where relevant;
- security-safe metadata, such as old/new role, Admin assignment, Manager assignment, or invitation expiry time.

Audit metadata must never contain:

- passwords;
- raw session tokens;
- raw invitation tokens;
- password-reset tokens;
- 2FA secrets;
- other credentials or authentication secrets.

### 12.3 Events to record

The system must record security-relevant organization events, including:

#### Organization events

- Organization created.
- Organization settings updated.
- Ownership transferred.

#### Invitation events

- Invitation created.
- Invitation resent.
- Invitation accepted.
- Invitation revoked.
- Invitation expired when the expiration is observed.

#### Membership events

- Membership created/joined.
- Membership role changed.
- Admin assignment changed.
- Manager assignment changed.
- Membership removed.

#### Session events

- Session created.
- Session revoked.
- All sessions revoked.

#### Authentication events

- Password changed.
- Password reset completed.
- Login success.
- Logout.
- Failed login attempts at the appropriate security logging layer.

#### Authorization events

Sensitive authorization denials must be recorded, including:

- Insufficient permission or role.
- Cross-organization access attempt.
- Admin-scope authorization failure.
- Manager-scope authorization failure.
- Attempt to access a resource outside the actor's permitted scope.

Audit events must be generated from trusted server-side state. Client-supplied role, organization, user, or scope information must never be treated as authoritative when constructing an audit record.

## 13. Authorization decision flow

Every organization-scoped protected action must pass through the following authorization sequence:

```
Request
  ↓
Valid session / authenticated user?
  ├─ No → deny (unauthenticated)
  ↓ Yes
Target organization resolved from trusted request context
  ↓
Actor has active membership in that organization?
  ├─ No → deny (cross-organization or no membership)
  ↓ Yes
Actor's role has the required permission?
  ├─ No → deny (insufficient permission)
  ↓ Yes
Target resource exists and belongs to this organization?
  ├─ No → deny (tenant boundary or invalid target)
  ↓ Yes
Role hierarchy and administrative/resource scope permit this target?
  ├─ No → deny (for example, Admin A targeting Admin B's Member)
  ↓ Yes
Perform the requested action
  ↓
For state-changing actions:
  authorization check + mutation must be performed atomically
  ↓
Append the appropriate audit event when required
  ↓
Allow
```

Authorization must derive the actor's identity, organization membership, role, administrative scope, and reporting relationships from **trusted server-side state**.

The system must never treat a client-supplied role, user ID, Admin assignment, Manager assignment, or organization claim as authoritative for authorization.

Client-supplied identifiers may be used to identify the requested target, but the server must independently verify that the target exists, belongs to the requested organization, and falls within the actor's permitted scope.

Authorization must be enforced consistently across API endpoints, service-layer operations, background jobs, and data-access paths. No implementation layer may bypass the organization boundary, role permissions, or administrative scope rules.

A denied authorization decision must not perform the requested protected action. Sensitive authorization denials must be recorded according to the audit-logging rules.

## 14. Cross-organization isolation

Organizations are **hard tenant boundaries**. Data, memberships, invitations, sessions, audit records, and other organization-scoped resources must never be accessible across organizations unless explicitly defined as global account-level data.

For every organization-scoped read or write, the system must verify that:

1. The actor has an active membership in the requested organization.
2. Every organization-scoped target resource belongs to the same organization as the request.
3. The actor's role, permissions, and administrative scope are evaluated within that organization only.
4. Organization membership or authorization in one organization never grants access to resources in another organization.

An identifier guessed, leaked, or obtained from Organization B must never allow a user acting within Organization A to view, modify, revoke, remove, or audit Organization B's resources.

For example:

```
User
├── Organization A → Admin
└── Organization B → Member
```

When the user accesses Organization A:

```
Organization A
    ↓
Membership = Admin
    ↓
Evaluate Admin permissions and scope
```

When the same user accesses Organization B:

```
Organization B
    ↓
Membership = Member
    ↓
Evaluate Member permissions and scope
```

The Admin role in Organization A must provide **no additional authority** within Organization B.

Similarly, the Member role in Organization B must not restrict or alter the user's independent Admin membership in Organization A.

A user who belongs to multiple organizations therefore receives a **separate authorization evaluation for every organization-scoped request**.

The organization boundary must be enforced server-side at every relevant layer, including API handlers, service logic, background jobs, and data-access operations. Client-supplied organization identifiers must never be treated as proof of membership or authorization.

A failure to establish the correct organization boundary must result in denial of the requested action and, where security-relevant, an appropriate audit or security event.

## 15. Business rules and edge cases

| Situation                                                                              | Required behavior                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Super User would be directly removed or demoted                                        | Reject the action. The current Super User may cease to be Super User only through an ownership transfer to an eligible existing organization member. The previous Super User becomes an Admin as part of that transfer.                                                             |
| Super User ownership transfer                                                          | The target must already be an organization member and must be eligible to become the new Super User. The transfer must be performed atomically and recorded in the audit log. The previous Super User becomes an **Admin**, and the target member becomes the new Super User/Owner. |
| Admin tries to manage the Super User, another Admin, or another Admin's Manager/Member | Deny and log the sensitive authorization denial.                                                                                                                                                                                                                                    |
| Admin targets an unassigned Manager                                                    | Deny. Only the Super User may assign, manage, or remove an unassigned Manager.                                                                                                                                                                                                      |
| Manager targets a Member assigned to another Manager                                   | Deny and log the sensitive authorization denial.                                                                                                                                                                                                                                    |
| Manager targets an unassigned Member                                                   | Deny. Only an Admin or the Super User may manage an unassigned Member.                                                                                                                                                                                                              |
| Member tries any membership-management action                                          | Deny.                                                                                                                                                                                                                                                                               |
| Member is promoted to Manager                                                          | The Member's existing Manager assignment is cleared because the user is no longer a Member. The new Manager must be assigned to an Admin or remain unassigned according to the authorization rules.                                                                                 |
| Manager is promoted to Admin                                                           | The Manager's Admin assignment is cleared because the user is no longer a Manager. The user becomes an Admin with a new administrative scope.                                                                                                                                       |
| Manager is reassigned to another Admin                                                 | The Manager leaves the former Admin's scope and enters the new Admin's scope. The Manager's direct Members remain assigned to that Manager and therefore move into the new Admin's scope atomically.                                                                                |
| Manager is removed                                                                     | The Manager's direct Members remain organization members but become unassigned. An Admin within the relevant scope or the Super User must reassign them if needed.                                                                                                                  |
| Admin is removed                                                                       | The Admin's assigned Managers become unassigned. Their Managers' Members remain assigned to those Managers. Only the Super User may reassign those Managers to another Admin.                                                                                                       |
| Invitation sent to an existing member                                                  | Do not create a second membership. Reject the invitation before sending or close it upon acceptance without changing the existing membership.                                                                                                                                       |
| Duplicate pending invitation for the same email and organization                       | Reuse/resend the existing valid invitation or require the existing invitation to be revoked first. Never create ambiguous concurrent offers.                                                                                                                                        |
| Invitation recipient signs in with a different email                                   | Deny acceptance.                                                                                                                                                                                                                                                                    |
| Invitation is expired, revoked, or already used                                        | Do not create a membership or expose a usable acceptance path.                                                                                                                                                                                                                      |
| Inviter loses authority after issuing an invitation                                    | The existing pending invitation may remain valid unless an authorized actor revokes it. At acceptance time, the system must revalidate the offered role and reporting assignment against the organization's current rules.                                                          |
| Organization member is removed                                                         | Their membership-based access to that organization ends immediately. Their global account and memberships in other organizations remain unaffected.                                                                                                                                 |
| User revokes a session                                                                 | Subsequent requests using that session are rejected.                                                                                                                                                                                                                                |
| Member is reassigned to another Manager                                                | The Member immediately leaves the previous Manager's scope and enters the new Manager's scope. If the Managers belong to different Admins, the Member also moves between those Admin scopes.                                                                                        |
| Member's Manager is removed                                                            | The Member remains in the organization but becomes unassigned.                                                                                                                                                                                                                      |
| Admin's Manager is reassigned                                                          | The Manager and all of that Manager's direct Members move from the former Admin's scope to the new Admin's scope atomically.                                                                                                                                                        |
| Concurrent privileged changes                                                          | Use atomic checks and writes so a role, administrative assignment, reporting assignment, or membership cannot change between authorization and execution.                                                                                                                           |
| Cross-organization target                                                              | Deny the action even when the requester knows the target's identifier. Organization membership and scope must be evaluated independently for every organization.                                                                                                                    |
| Equal-role management attempt                                                          | Deny unless the action is explicitly permitted by the role and scope rules. Having the same role does not grant authority over another user with that role.                                                                                                                         |

## 16. Security requirements

### 16.1 Transport and session security

- Enforce HTTPS in deployed environments.
- Session cookies must use `Secure` and `HttpOnly` attributes and an appropriate `SameSite` policy.
- Session identifiers must be generated using cryptographically secure randomness.
- Revoked or expired sessions must be rejected on every subsequent authenticated request.
- State-changing browser requests must be protected against CSRF when cookie-based authentication is used.

### 16.2 Password and credential security

- Store password hashes only. Passwords must be hashed using **Argon2id** with production-appropriate parameters.
- Plaintext passwords must never be stored, logged, or included in audit records.
- Password-reset tokens, invitation tokens, and session tokens must be generated using cryptographically secure randomness.
- Where feasible, store hashes of reset, invitation, and session tokens rather than their raw values.
- Raw authentication tokens must never be logged or included in audit metadata.
- Password-reset tokens must be single-use and have a short expiration period.
- Successful password changes and password resets must invalidate existing sessions according to the session-management rules.

### 16.3 Email and invitation security

- Validate and normalize email addresses consistently throughout registration, invitation, and authentication flows.
- Invitation acceptance must be bound to the authenticated account's verified email address.
- The verified email must exactly match the normalized email address to which the invitation was issued.
- Invitations must be single-use and expire after the defined validity period.
- Invitation tokens must be opaque and must not contain sensitive information.
- Invitation acceptance must revalidate the invitation's role and reporting assignment against the organization's current authorization rules.

### 16.4 Rate limiting and abuse protection

Apply appropriate rate limits and abuse controls to:

- account registration;
- login attempts;
- password-reset requests;
- password-reset attempts;
- invitation creation;
- invitation acceptance;
- email verification;
- other authentication-sensitive operations.

Use generic responses where necessary to avoid unnecessary account enumeration. For example, a password-reset request should not reveal whether a particular email address is registered.

### 16.5 Input and data-access security

- Validate all input server-side.
- Never trust client-supplied roles, permissions, organization identifiers, Admin assignments, Manager assignments, or other authorization-related claims.
- Use parameterized queries or safe ORM/data-access mechanisms to prevent SQL injection.
- Apply output encoding appropriate to the delivery context to prevent injection vulnerabilities.
- Enforce authorization on the server for every protected operation.
- UI restrictions must never be treated as a security boundary.

### 16.6 Multi-tenant isolation

- Check the actor's organization membership, target organization, role, permission, and administrative/resource scope on every organization-scoped access.
- Apply the same organization-boundary checks to reads, writes, background jobs, scheduled tasks, and other server-side operations.
- Never assume that possession of a resource identifier proves authorization to access that resource.
- A resource identifier from another organization must not provide access to that resource.
- Avoid returning errors or response data that unnecessarily reveal the existence of another organization's resources, memberships, invitations, or sessions.

### 16.7 Authorization security

- Authorization decisions must be based on trusted server-side state.
- Authentication must be evaluated separately from authorization.
- Every protected organization-scoped action must verify the actor's active membership in the target organization.
- Every target resource must be verified as belonging to the requested organization.
- Role permissions and administrative/resource scope must both be evaluated before allowing a protected action.
- Authorization must follow the deny-by-default principle: actions not explicitly permitted by the specification must be rejected.
- Privileged state-changing operations must perform authorization checks and mutations atomically to prevent race conditions.

### 16.8 Audit security

- Audit logs must be append-only.
- No product role may edit or delete audit records.
- Audit records must be scoped to the organization in which the event occurred.
- Only the Super User and Admins may view organization audit logs.
- Audit metadata must never contain passwords, raw session tokens, raw invitation tokens, password-reset tokens, 2FA secrets, or other authentication secrets.
- Sensitive authorization denials must be recorded according to the audit-logging rules.

### 16.9 Sensitive operations

Require recent authentication or re-authentication before especially sensitive operations where appropriate, including:

- ownership transfer;
- password change;
- password reset;
- enabling or disabling 2FA;
- changing critical account-security settings.

Additional authentication hardening may be introduced in later releases as the security model evolves.

## 17. Acceptance criteria

The first release satisfies this specification when all of the following are demonstrably true:

1. A verified user can create an organization and becomes its **sole Super User/Owner**.
2. The same user can join a second organization and hold a different role there.
3. An organization has exactly one Super User/Owner and may have multiple Admins. Each Admin can manage only their assigned Managers and the Members managed by those Managers, plus unassigned Members as permitted by the authorization rules.
4. An Admin cannot edit, remove, reassign, invite for, or otherwise manage another Admin's Managers or Members.
5. The Super User can manage every Admin, Manager, Member, invitation, and reporting relationship within the organization, including assigning Managers to Admins and Members to Managers.
6. A Manager can manage only Members directly assigned to that Manager. A Manager cannot manage another Manager's Members, unassigned Members, Managers, Admins, or the Super User.
7. A Member cannot manage memberships, invitations, reporting assignments, or other members.
8. All organization members can see the organization's reporting structure and counts without gaining modification rights outside their permitted administrative scope.
9. An authorized invitation clearly displays the organization and offered role, expires after seven days, is single-use, and contains only a reporting assignment permitted by the inviter's authority.
10. An existing account holder can authenticate and accept an invitation; a new recipient can create and verify an account using the invited email address before accepting it.
11. Invitation acceptance fails when the authenticated verified email does not match the invitation email, the invitation is expired, revoked, or already used, a duplicate membership would result, or the offered role or reporting assignment is no longer valid under the organization's current rules.
12. A user can maintain multiple concurrent sessions, view and revoke an individual session, and revoke all of their sessions. A revoked or expired session cannot authorize another request.
13. Sensitive successful actions and meaningful authorization denials produce immutable, appropriately scoped audit records.
14. Requests attempting to access a membership, invitation, session, audit record, or other organization-scoped resource belonging to another organization are denied regardless of whether the requester knows the resource identifier.
15. The system enforces the single-Super-User invariant: an organization must always have exactly one Super User/Owner. The current Super User cannot be directly removed or demoted. Ownership must first be transferred to an eligible existing organization member. Upon successful ownership transfer, the previous Super User becomes an Admin and the target member becomes the new Super User/Owner.

## 18. Future extensions and deferred artifacts

The following capabilities and implementation artifacts are intentionally deferred until the initial authentication, multi-tenancy, authorization, invitations, sessions, and audit logging are correctly implemented and tested.

### 18.1 TOTP-based two-factor authentication

Implement app-based TOTP as the first additional authentication factor. SMS-based 2FA is not planned for the initial 2FA implementation.

The TOTP flow should be:

1. The user starts 2FA enrollment.
2. The system generates a cryptographically secure TOTP secret.
3. The system presents the secret through a QR code and, where appropriate, a manual setup key.
4. The user scans the QR code with an authenticator application.
5. The user confirms enrollment by providing a valid six-digit TOTP code.
6. The system enables TOTP for the account.
7. The system generates one-time recovery codes.
8. Future password-based logins require both the user's password and a valid TOTP code, unless a valid unused recovery code is used.

Recovery codes must:

- be displayed to the user only when generated or regenerated;
- be stored only as secure hashes;
- be single-use;
- be invalidated immediately after use;
- never be stored or logged in plaintext.

TOTP secrets and recovery codes must never appear in audit logs or application logs.

2FA is an **authentication control**. It does not change organization membership, roles, permissions, administrative scope, or reporting relationships.

### 18.2 Deferred implementation artifacts

The following artifacts will be created after the product and authorization rules are finalized:

- **Database design** derived from the entities, relationships, constraints, and invariants defined in this specification.
- **Database migrations** implementing the approved database design.
- **ORM/data-access models** derived from the database design.
- **API specification** defining endpoint contracts, request/response formats, authentication requirements, authorization checks, and error behavior.
- **Authorization implementation design** mapping each protected operation to its required permission and scope checks.
- **Automated authorization and security test plan** covering role boundaries, administrative scope, tenant isolation, invitations, sessions, and security invariants.

### 18.3 Future product capabilities

The following product capabilities are outside the initial release:

- Custom roles and permission bundles.
- Groups and more flexible team structures.
- Indirect reporting structures and more flexible delegation.
- Enterprise SSO.
- SCIM provisioning.
- External identity-provider federation.
- Enterprise security policies.
- Device and session risk signals.
- Advanced audit-log retention, export, search, alerting, and compliance features.
- Billing and subscription management.

## 19. Implementation principle

The system follows a **deny-by-default** authorization model. When an action is not explicitly permitted by this specification, the system must deny the action.

Every implementation layer—including the user interface, API handlers, service logic, background jobs, scheduled tasks, and data-access layer—must preserve the same:

- organization/tenant boundary;
- role hierarchy;
- permission rules;
- administrative scope;
- reporting relationships;
- authentication requirements; and
- security invariants.

No implementation layer may bypass or weaken an authorization rule enforced by another layer.

Client-side restrictions are not security controls. The server must independently authenticate the user and evaluate organization membership, role, permission, target resource, and administrative scope before allowing a protected operation.

Authorization must be enforced consistently regardless of how an operation is initiated, whether through a normal API request, background job, scheduled task, or other internal execution path.

When authorization cannot be established with sufficient confidence, the system must deny the operation rather than attempt to infer or assume permission.
