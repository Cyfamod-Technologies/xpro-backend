# Background Jobs

BullMQ on Redis. Queue names are declared once in `src/jobs/jobs.constants.ts` and
registered from that list, so adding a queue is a single-source change.

## Queues

| Queue | Producer | Consumer | Purpose |
| --- | --- | --- | --- |
| `email` | `JobsService.addEmailJob` | `EmailProcessor` | Renders and sends queued email, updates the `Notification` row |
| `audit-logs` | `JobsService.addAuditLogJob` | `AuditLogsProcessor` | Writes `AuditLog` rows off the request path |
| `platform` | `JobsService` (repeatable) | `PlatformProcessor` | Housekeeping such as expired idempotency keys |
| `outbox` | `OutboxService.kick()` and a 30 s repeatable sweep | `OutboxProcessor` | Delivers `outbox_events` rows (`email.notify` → `request_update` email). Retries live on the row: 5 attempts, waits of 1, 5, 15 and 60 min, then a `FailedJob` |

## Default job options

Set once in `BullModule.forRootAsync` (`app.module.ts`):

```ts
{
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 100 },
}
```

Override per producer method where a queue needs different behaviour — the audit
queue uses `attempts: 5` because losing an audit entry is worse than retrying.

## Producing

Always go through `JobsService`. Never inject a `Queue` into a feature service and
never call a processor directly:

```ts
this.jobs.addEmailJob('welcome', { notificationId, recipientEmail, templateKey, payload, type });
this.jobs.addAuditLogJob({ actorType, actorId, entityType, action, timestamp });
```

For email specifically, prefer `NotificationsService.queueEmail()` over
`addEmailJob` directly — it creates the `Notification` row and applies the
duplicate-suppression cooldown before enqueuing.

## Consuming

Processors extend `WorkerHost` and live in `src/jobs/processors/`:

```ts
@Processor('my-queue')
export class MyProcessor extends WorkerHost {
  private readonly logger = new Logger(MyProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly failedJobs: FailedJobsService,
  ) {
    super();
  }

  async process(job: Job<MyPayload>): Promise<void> {
    try {
      // ...
    } catch (error) {
      await this.failedJobs.record('my-queue', job, error);
      throw error; // rethrow so BullMQ counts the attempt
    }
  }
}
```

Two rules worth following:

- **Rethrow after recording.** Swallowing the error marks the job completed and
  cancels the retry.
- **Only record on the final attempt** when a queue has retries, or you will write
  one `FailedJob` row per attempt. `EmailProcessor` shows the pattern:

  ```ts
  const attempts = job.opts.attempts ?? 1;
  const finalAttempt = job.attemptsMade + 1 >= attempts;
  if (finalAttempt) await this.failedJobs.record('email', job, error);
  ```

## Failure handling

`FailedJobsService.record()` persists queue name, job id, job name, payload and
error message to `FailedJob`, uniquely keyed on `(queueName, jobId)` so repeated
failures update rather than duplicate. `FailedJobsService.retry(id)` re-enqueues
from the stored payload and stamps `retriedAt`.

`JobsService.getQueueStats()` returns live waiting/active/completed/failed counts
per queue — useful behind an admin route or a metrics endpoint.

## Idempotency

Retries mean every processor must tolerate running twice on the same payload.
Prefer `upsert` over `create`, derive state from a `COUNT(*)` rather than
incrementing a counter, and use a deterministic `jobId` when you want a newer job
to replace a pending one:

```ts
queue.add('name', data, { jobId: `thing:${thingId}`, delay: 30_000 });
```

## Adding a queue

1. Add the name to `QUEUE_NAMES` in `jobs.constants.ts`, with a comment saying who
   produces and who consumes.
2. Inject it in `JobsService` and add a typed `add*Job` producer method.
3. Add it to the `getQueue()` map.
4. Create the processor in `src/jobs/processors/` and register it in `JobsModule`.

Registration in `JobsModule` is driven off `QUEUE_NAMES`, so step 1 wires the queue
itself — steps 2–4 are the producer and consumer.

## Local inspection

Queues are plain Redis keys:

```bash
docker compose exec redis redis-cli KEYS 'bull:*'
docker compose exec redis redis-cli LLEN 'bull:email:wait'
```
