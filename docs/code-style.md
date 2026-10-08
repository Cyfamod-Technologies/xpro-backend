# Code Style

## TypeScript

- TypeScript 5 with strict mode. Do not use `any` — use `unknown` and narrow.
- Imports use path aliases: `src/` maps to the project root (`tsconfig-paths` at runtime).
- Avoid barrel files (`index.ts`) unless the folder already uses one.

## NestJS conventions

### Controllers

Controllers handle HTTP only. Apply guards, call the service, return the result.

```ts
@ApiTags('widgets')
@ApiBearerAuth()
@Controller('widgets')
export class WidgetsController {
  constructor(private readonly widgets: WidgetsService) {}

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.widgets.findOne(user.id, id);
  }
}
```

Never put business logic in a controller. Validation, guard checks, and service delegation only.

### Services

Services own all business logic. Inject `PrismaService`, other services, `JobsService`, etc. via the constructor.

Prefer splitting large services into focused files in the same directory rather than adding section-header comments inside a single file.

### Module registration

Every feature module must be imported in `src/app.module.ts`. Import shared infrastructure (`PrismaModule`, `JobsModule`, `RedisModule`, `StorageModule`) in the feature module, not ad hoc.

```ts
@Module({
  imports: [PrismaModule, JobsModule],
  controllers: [MyFeatureController],
  providers: [MyFeatureService],
})
export class MyFeatureModule {}
```

### Dependency injection

Always inject through the constructor. Never use `app.get()` outside bootstrap. Use `@Inject('TOKEN')` for custom injection tokens (e.g., `REDIS_CLIENT`).

## DTOs and Swagger

Every DTO field must have a `class-validator` decorator and an `@ApiProperty` decorator:

```ts
export class CreateWidgetDto {
  @ApiProperty({ description: 'Human-readable widget name' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;
}
```

`ValidationPipe` is global with `whitelist: true` — undeclared fields are stripped. Use `@IsOptional()` on optional fields. Use `@Type(() => Number)` for numeric query params.

Controller-level Swagger:

```ts
@ApiTags('widgets')
@ApiBearerAuth()          // matches the 'bearer' scheme name in main.ts
@ApiOperation({ summary: 'List widgets for the authenticated user' })
```

## Error handling

Use NestJS built-in exception classes:

```ts
throw new NotFoundException('Widget not found');
throw new ForbiddenException('Access denied');
throw new BadRequestException('Name is required');
throw new UnauthorizedException('Invalid credentials');
```

Match the error type already used in the file you are editing. The global `ExceptionLoggingFilter` formats all errors into a consistent response shape.

## Prisma

- Access the database exclusively through the injected `PrismaService`.
- `Json` fields require `Prisma.InputJsonValue` — convert DTO class instances to plain objects before persisting:

```ts
data: {
  config: dto.config as unknown as Prisma.InputJsonValue,
}
```

- Use `$transaction([...])` for multi-step writes that must be atomic.
- Use `$executeRaw` for operations that Prisma's query builder cannot express (e.g. bulk deletes). Always use the tagged-template form so values are parameterised.
- Select only the columns you need: use `select` on read-heavy paths.

## Queues

Never call a processor directly. Enqueue jobs only through `JobsService`:

```ts
this.jobs.addEmailJob('welcome', { notificationId, recipientEmail, ... });
this.jobs.addAuditLogJob({ actorType, action, entityType, ... });
```

Processors extend `WorkerHost`:

```ts
@Processor('my-queue')
export class MyProcessor extends WorkerHost {
  async process(job: Job<MyPayload>): Promise<void> {
    // ...
  }
}
```

## Naming conventions

| Thing | Convention | Example |
| --- | --- | --- |
| Files | kebab-case | `audit-logs.service.ts` |
| Classes | PascalCase | `AuditLogsService` |
| Methods | camelCase | `findAllSources` |
| Queue names | kebab-case string | `'audit-logs'` |
| Env variables | SCREAMING_SNAKE | `REDIS_HOST` |
| Prisma models | PascalCase | `FailedJob` |
| Database tables | snake_case (Prisma maps) | `failed_jobs` |
| DTOs | `<Action><Entity>Dto` | `CreateWidgetDto` |

## Response shape

The global `ResponseInterceptor` produces:

```json
{ "statusCode": 200, "message": "Success", "data": { ... } }
```

Override defaults per handler:

```ts
@SuccessResponse({ statusCode: 201, message: 'Created' })
@Post()
create(...) { ... }
```

SSE and streaming handlers write to `res` directly — the interceptor skips them when `res.headersSent` is true.

## Logging

Use `new Logger(ClassName.name)` per class. Log at the appropriate level:

- `logger.log(...)` — normal operations (job started, resource created).
- `logger.warn(...)` — recoverable issues (file failed to process within a larger batch).
- `logger.error(...)` — failures that need attention.
- `logger.debug(...)` — high-frequency detail suitable only for debugging.

Log structured fields inline: `logger.log(\`action  key=value  key2=value2\`)`.

## Comments

Add a comment only when the WHY is non-obvious: a hidden constraint, a workaround for a specific bug, or an external requirement.

Do not add:
- Section divider comments (`// ─── Section ───`)
- Comments that label groups of functions (`// Helper functions`)
- Comments that restate what the code already shows

JSDoc on public service methods is acceptable when it describes non-obvious params, return shapes, or side effects. Skip it when it just repeats the method name.

## Diff scope

Change only what the task requires. Do not refactor, reformat, or rename unrelated code in the same diff. Do not fix whitespace or sort imports in files you are not otherwise modifying.
