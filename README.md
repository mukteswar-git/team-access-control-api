# Team Access Control API

A backend-only, multi-tenant Identity and Access Management (IAM) API built with **Node.js, TypeScript, Express, PostgreSQL, and Prisma**.

The API provides user authentication, organization management, team memberships, role-based authorization, invitations, session management, and audit logging. It is designed around a core security principle: **authentication identifies the user; authorization determines what that user can do within a specific organization and resource scope.**

## Live Demo

- **API Base URL:** https://team-access-control-api-o2cn.onrender.com
- **Interactive API Documentation:** [Swagger UI](https://team-access-control-api-o2cn.onrender.com/api-docs/)
- **Health Check:** [GET /health](https://team-access-control-api-o2cn.onrender.com/health)

The API is deployed on Render and uses Neon PostgreSQL for hosted database storage.

## Features

### Authentication and Account Security

- User registration and login
- Email verification
- Password reset and recovery
- Secure password hashing with Argon2id
- Database-backed sessions and session revocation
- Single-use, hashed verification and password-reset tokens
- Rate limiting for authentication endpoints

### Multi-Tenant Organization Management

- Organization creation and management
- Organization-specific memberships and roles
- Invitation creation, delivery, and acceptance
- Membership and role assignment management
- Organization-aware authorization checks

### Authorization and Access Control

- Role-based access control (RBAC)
- Permission-based authorization
- Resource and administrative scope checks
- Membership hierarchy and reporting relationships
- Organization isolation to prevent unauthorized cross-tenant access
- Server-side authorization rather than trusting client-provided identifiers

### Auditability

- Organization-scoped audit logs
- Tracking of security-sensitive operations
- Append-only audit records

### Developer Experience

- REST API built with Express and TypeScript
- Request validation using Zod
- PostgreSQL schema management and migrations with Prisma
- Interactive API documentation using Swagger and OpenAPI
- Automated tests with Jest and Supertest
- Docker Compose for local development dependencies

## Technology Stack

| Technology        | Purpose                              |
| ----------------- | ------------------------------------ |
| Node.js           | JavaScript runtime                   |
| TypeScript        | Type safety                          |
| Express           | HTTP server, routing, and middleware |
| PostgreSQL        | Relational data storage              |
| Prisma            | ORM, schema, and database migrations |
| Argon2id          | Password hashing                     |
| Zod               | Request and environment validation   |
| Jest              | Automated testing                    |
| Supertest         | HTTP endpoint testing                |
| Swagger / OpenAPI | API documentation                    |
| Docker Compose    | Local development infrastructure     |
| Render            | API hosting                          |
| Neon              | Hosted PostgreSQL                    |

## Authorization Model

The API separates global user identity from organization-specific membership.

A user can belong to multiple organizations, with different roles and access scopes in each organization.

The implemented role model includes:

- **Super User** — elevated system-level access
- **Admin** — organization administration
- **Manager** — access within assigned administrative scope
- **Member** — restricted access according to permissions and reporting relationships

Authorization is evaluated on the server. Possessing an organization ID or resource ID does not automatically grant access to it.

The application checks relevant factors such as authentication, active membership, permissions, organization ownership, and resource scope before allowing protected operations.

## Security Practices

The project incorporates several security controls:

- Passwords are hashed rather than stored in plaintext.
- Authentication and recovery tokens are stored as hashes.
- Request data is validated before reaching business logic.
- Authentication endpoints use rate limiting.
- Protected endpoints require authentication.
- Organization-scoped access is checked independently for each request.
- Sensitive operations are recorded in audit logs.
- Database relationships and constraints help preserve data integrity.
- Secrets are supplied through environment variables rather than committed to source control.

This is a personal learning project and should not be considered independently audited or certified for production use.

## Getting Started

### Prerequisites

Install the following:

- Node.js and npm
- PostgreSQL, or a compatible hosted PostgreSQL database
- Git

Docker Compose can be used for local development dependencies if desired.

### 1. Clone the repository

```bash
git clone https://github.com/mukteswar-git/team-access-control-api.git
cd team-access-control-api
```

### 2. Install dependencies

```bash
npm ci
```

### 3. Configure environment variables

Create a local `.env` file using `.env.example` as a reference.

Required variables:

```dotenv
DATABASE_URL="your-postgresql-connection-string"
RESEND_API_KEY="your-resend-api-key"
FRONTEND_URL="http://localhost:3000"
```

Replace the example values with your own configuration. Never commit `.env` or share real credentials publicly.

`FRONTEND_URL` is used for frontend-related links. If you test email verification or password recovery, ensure those links point to a reachable destination appropriate to your environment.

### 4. Generate Prisma Client

```bash
npx prisma generate
```

### 5. Apply database migrations

For a local development database with existing migration history:

```bash
npx prisma migrate dev
```

For a deployed or production database:

```bash
npx prisma migrate deploy
```

Use the command appropriate to your environment. Do not run development migrations against the production database.

### 6. Seed the Database (Optional)

If the project includes seed data for local development, run:

```bash
npx prisma db seed
```

Use seed data only in a development or test database. Do not run development seed scripts against your production database unless they are explicitly designed for production use.

### 7. Start the development server

```bash
npm run dev
```

The API uses port `3000` by default unless the `PORT` environment variable overrides it.

## Available Scripts

| Command                 | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `npm run dev`           | Start the development server with automatic restarts |
| `npm run build`         | Compile TypeScript                                   |
| `npm start`             | Start the compiled application                       |
| `npm run typecheck`     | Check TypeScript types without emitting files        |
| `npm test`              | Run the Jest test suite                              |
| `npm run test:watch`    | Run tests in watch mode                              |
| `npm run test:coverage` | Run tests with coverage reporting                    |
| `npm run format`        | Format supported files with Prettier                 |
| `npm run format:check`  | Check formatting                                     |
| `npm run openapi:lint`  | Lint the OpenAPI specification                       |

## API Documentation

The deployed Swagger UI provides an interactive reference for the documented endpoints, request schemas, responses, and authentication requirements.

**[Open the API Documentation](https://team-access-control-api-o2cn.onrender.com/api-docs/)**

For protected endpoints, obtain a session token through the login endpoint and provide it using the documented Bearer authentication scheme.

## Deployment

The API is deployed as a Render Web Service. PostgreSQL is hosted separately on Neon.

The deployment uses environment variables for database connectivity and email delivery configuration. Prisma migrations are applied during service startup.

The free hosting configuration may spin down after inactivity, so the first request after a period of inactivity can take longer than subsequent requests.

## Project Goals

This project was built to practice backend engineering beyond basic CRUD operations, including:

- Authentication and session lifecycle management
- Multi-tenant database design
- RBAC and permission enforcement
- Resource-level authorization
- Secure token handling
- Transactional data integrity
- Audit logging
- Automated testing and API documentation
- Deployment and environment configuration
