# TradeMind — System Architecture

This document provides a high-level overview of TradeMind's system architecture. It is intended as internal architecture documentation for a personal-use trading platform that integrates with Upstox and is implemented using Express + TypeScript, Prisma + MySQL, Redis, and BullMQ. The goal is to describe the system structure, responsibilities, data flow, and guiding principles without implementation details.

---

## Project Overview

TradeMind is a personal-use, single-user trading assistant focused on the Upstox brokerage. It is designed as a local/private application for one operator and aims to provide a reliable, modular foundation for trade automation and monitoring. The backend is written in TypeScript and uses an Express HTTP API. Persistence is handled by Prisma with MySQL, while Redis and BullMQ provide caching and background job processing respectively. A React frontend is planned for a later phase.

Key constraints:
- Single user (no multi-tenant or SaaS concerns)
- Upstox is the only broker integration planned initially
- No authentication, billing, or SaaS features
- AI features are deferred until rule-based engine is stable

---

## Design Goals

- Clear separation of concerns via a feature-based modular architecture
- Maintainability and extensibility through SOLID principles
- Predictable data flow using repository and service layers
- Robust background processing for long-running tasks and integrations
- Minimal attack surface consistent with single-user local deployment (no authentication)
- Readiness for a React frontend and potential AI enhancements after core stability

---

## Technology Stack

- Backend: Node.js, Express, TypeScript
- ORM: Prisma
- Primary database: MySQL
- Cache / transient store: Redis
- Queue / background jobs: BullMQ (backed by Redis)
- Task scheduling / workers: Node-based worker processes using BullMQ
- Frontend (future): React
- External integration: Upstox API/SDK

---

## High-Level Architecture Diagram (ASCII)

Legend: [->] synchronous call, [=>] asynchronous job/event

+----------------------+        +---------------------+        +------------------+
|  React Frontend      |  ->    |  Express API Server |  ->    |  Upstox (Broker) |
|  (future)            |        |  (TypeScript)       |        |  Integration API  |
+----------------------+        +---------------------+        +------------------+
                                       |      ^  
                                       |      | Upstox responses
                                       |      |
                          +------------v------+------------+
                          |  Feature Modules (controllers,|   
                          |  services, repositories)      |   
                          +-------------------------------+
                                       |     |
        +------------------------------+     +-----------------------------+
        |                                                  |                |
+-------v-------+      +----------------------+      +-------v--------+ +----v----+
|  Prisma Repo  | <--> |    MySQL Database    |      |  Redis Cache   | | BullMQ  | 
| (Repository)  |      |  (Persistent store)  |      |  (TTL, locks)  | | (Queue) |
+---------------+      +----------------------+      +----------------+ +---------+
                                                         |                 
                                                         | BullMQ uses Redis
                                                         v
                                                  +----------------+
                                                  | Background     |
                                                  | Workers        |
                                                  +----------------+

Notes:
- Controllers handle HTTP requests and delegate to services.
- Services orchestrate business logic and use repositories for persistence.
- BullMQ (Redis) handles background tasks such as order reconciliation, polling, and scheduled jobs.

---

## Core Modules

The system is organized around a feature-based module layout. Major top-level areas include:

- core (infrastructure)
  - logging, configuration, database connection, Redis, queueing, event bus
- common (shared utilities)
  - HTTP response shapes, DTOs shared across modules, small helpers
- modules (feature modules)
  - health (health & readiness endpoints)
  - trading (trade commands, rule engine, order repository) — planned
  - integration/upstox (Upstox client wrappers and adapters)
  - jobs (background job handlers and workers)
- middleware
  - global HTTP middleware (error handling, request logging, not-found)

Empty or scaffolded folders are kept for future modules to maintain clear boundaries and allow incremental development.

---

## Responsibilities of Each Module

- core
  - Provide infrastructure services to the rest of the system: configuration loader, typed logger, database connection initializers, Redis and BullMQ clients, and an internal events bus.
  - Encapsulate infrastructure concerns so feature modules remain focused on business logic.

- common
  - Hold small, reusable constructs that have no domain-specific behavior (e.g., standardized API response forms, application DTO definitions used across modules).

- modules/* (feature modules)
  - Each feature owns its own controller(s), service(s), repository(ies), DTOs, and interfaces.
  - Controllers: adapt HTTP requests to service calls and return standardized responses.
  - Services: implement orchestration and business rules (rule engine for trading), delegating persistence to repositories and long-running work to jobs.
  - Repositories: implement the repository pattern to isolate Prisma and persistence logic from services.
  - Routes: expose module-specific endpoints; register with central router.

- middleware
  - Cross-cutting request handling (e.g., logging, error responses, not-found handling).
  - Kept independent from features so they can be applied globally or selectively.

- jobs / workers
  - Implement background processing (BullMQ workers). Typical responsibilities include polling external APIs, reconciling orders, and running scheduled rule evaluations.

---

## Data Flow Overview

1. Client interaction (future React UI) or scheduled/cron triggers send requests to Express API endpoints.
2. Requests are routed to feature controllers which validate and adapt inputs into DTOs.
3. Controllers forward to service layer where orchestration occurs:
   - Business rules (rule-based engine) determine next actions.
   - Services call repositories for persistence through Prisma.
   - Services enqueue background jobs in BullMQ for tasks that must run asynchronously.
4. Repositories interact with the MySQL database via Prisma using a repository interface that hides ORM specifics.
5. Redis is used for short-lived caches, idempotency locks, and as BullMQ's backing store.
6. Background workers consume BullMQ queues, perform work (e.g., call Upstox APIs, reconcile trades) and persist results through repositories.
7. The system emits internal events (lightweight event bus) for cross-module communication; listeners react to events and may enqueue further jobs.
8. Responses follow a standardized API shape served from common utilities.

---

## Architectural Principles

- Modularity: Features are self-contained and own their controllers, services, repositories, DTOs, and interfaces.
- Separation of concerns: Controllers, services, and repositories have distinct responsibilities.
- Dependency inversion: Higher-level modules depend on abstractions (interfaces) rather than concrete implementations.
- Single responsibility: Classes and modules do one thing and do it well.
- Explicit boundaries: Core infrastructure services are centralized in `core` and consumed via thin adapters.
- Observable and testable: Side effects are isolated (repositories and workers), enabling unit and integration testing.

---

## Coding Principles

- TypeScript with strict typing for safer refactors and clearer contracts.
- SOLID principles applied at class and module level:
  - Single Responsibility: small classes with focused responsibilities.
  - Open/Closed: services open for extension by new features, closed for modification of existing stable logic.
  - Liskov Substitution: interfaces and derived implementations are interchangeable where applicable.
  - Interface Segregation: small, focused interfaces rather than large multipurpose ones.
  - Dependency Inversion: depend on interfaces/abstractions; inject concrete implementations at composition time.
- Repository pattern: Repositories encapsulate Prisma interactions and present a domain-focused API to services.
- Service layer: Business orchestration happens in services, not in controllers or repositories.
- Avoid global mutable state; prefer explicit initialization and injection of infrastructure resources.
- Keep middleware generic and free from domain logic.

---

## Future Expansion

Planned expansions and considerations:

- Trading feature module: rule engine, order lifecycle, trade history, and local risk controls.
- Upstox integration module: adapter that encapsulates all Upstox API interactions and handles rate limits/retries.
- Frontend React application that consumes the Express API; authentication is intentionally omitted for personal use.
- AI features: planned only after the deterministic, rule-based engine is stable. AI components will be implemented as optional services that consume sanitized data and provide recommendations; they must be toggleable and isolated.
- Advanced telemetry: metrics and tracing can be added to core for observability (kept out of business logic).
- Multi-environment support (dev/staging/production) via core configuration; keep secrets and environment handling out of source control.

---

This architecture favors clarity, maintainability, and incremental extension while respecting the single-user, Upstox-bound nature of the product. It deliberately avoids multi-tenant, billing, or authentication concerns and stages AI capabilities for a later phase after rule-based behavior is proven stable.
