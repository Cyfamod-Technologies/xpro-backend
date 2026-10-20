# Developer Docs

Architecture and conventions for this template, for both humans and coding agents.

| Document | Contents |
| --- | --- |
| [setup.md](setup.md) | Prerequisites, environment, dev/build commands, seed scripts |
| [architecture.md](architecture.md) | Bootstrap, modules, request lifecycle, auth, queues |
| [folder-structure.md](folder-structure.md) | Where feature modules, shared infra, jobs and scripts belong |
| [code-style.md](code-style.md) | TypeScript, NestJS, DTOs, Swagger, Prisma, naming |
| [security.md](security.md) | Guards, roles, surfaces, sessions, secrets |
| [background-jobs.md](background-jobs.md) | BullMQ queues, producers, processors, failure handling |
| [database.md](database.md) | Prisma conventions, migrations, seeding |
| [deployment.md](deployment.md) | Docker, compose, CI/CD, production checklist |
| [email/](email/README.md) | Email rendering and Hostinger SMTP setup |
| [storage/](storage/README.md) | Object storage setup (Cloudflare R2, AWS S3) |

Start with [architecture.md](architecture.md) for a system-wide orientation.
For quick setup, go to [setup.md](setup.md).
