# Team Access Control API

A multi-tenant SaaS backend for managing organizations, users, memberships, roles, and permissions.

## Overview

Team Access Control API is a backend project focused on authentication, authorization, and secure organization-level access control.

## Tech Stack

- Node.js
- TypeScript
- Express
- PostgreSQL
- Prisma ORM
- Redis
- Docker and Docker Compose
- Jest and Supertest

## Planned Features

- User registration and authentication
- Secure session and token management
- Organization and membership management
- Role-based access control (RBAC)
- Invitation management
- Session revocation
- Audit logging
- Request validation and centralized error handling
- API integration tests

## Project Status

Under development. Features and documentation will be updated as implementation progresses.

## Getting Started

Setup instructions, environment configuration, database migrations, and test commands will be documented as the project develops.

## API Documentation

The API is documented using OpenAPI 3.1.0 and Swagger UI.

When the development server is running, open:

- **Swagger UI:** http://localhost:3000/api-docs
- **Health check:** http://localhost:3000/health
- **OpenAPI specification:** `docs/openapi.yaml`

### Authentication

Protected endpoints require a bearer session token in the `Authorization` header.

```http
Authorization: Bearer <sessionToken>
```

Obtain a session token by calling `POST /auth/login`. In Swagger UI, use the **Authorize** control to configure authentication when testing protected endpoints.

### Validate API Documentation

Run the OpenAPI linter with:

```bash
npm run openapi:lint
```

The specification documents implemented API routes and their request schemas, responses, authentication requirements, and organization-level authorization rules.

## License

No license has been selected yet.
