# Object Storage

Storage is **opt-in**. Out of the box `STORAGE_DRIVER=none`, nothing is validated,
`StorageModule` is not imported, and the app boots without any bucket.

| Guide | When |
| --- | --- |
| [r2.md](r2.md) | Cloudflare R2 — the implemented driver |
| [s3.md](s3.md) | AWS S3 — what to change to switch |

## Design

Both providers speak the S3 API, so there is one code path (`@aws-sdk/client-s3`)
and one set of provider-neutral environment variables:

| Variable | Meaning |
| --- | --- |
| `STORAGE_DRIVER` | `none` (default) or `r2` |
| `STORAGE_BUCKET` | Bucket name |
| `STORAGE_REGION` | `auto` for R2, a real region for S3 |
| `STORAGE_ENDPOINT` | R2 account endpoint; omitted for S3 |
| `STORAGE_ACCESS_KEY_ID` | Access key |
| `STORAGE_SECRET_ACCESS_KEY` | Secret key |
| `STORAGE_PUBLIC_URL` | Base URL objects are served from |

Because the names are provider-neutral, switching providers changes values and a
small amount of client config — never variable names scattered through the code.

## Files

```
src/storage/
├── storage.config.ts    # Driver union, resolved config, env → config
├── storage.module.ts    # Builds the S3Client, provides StorageService
└── storage.service.ts   # upload / delete / signed URLs / read / publicUrl
```

`StorageService` takes its configuration by injection and never reads `process.env`,
so it cannot block startup. `resolveStorageConfig()` is the only place env is read.

## Turning it on

1. Follow [r2.md](r2.md) to create the bucket and credentials.
2. Set `STORAGE_DRIVER=r2` and the rest of the `STORAGE_*` block in `.env.local`.
3. Import `StorageModule` in whichever feature module needs it:

   ```ts
   @Module({
     imports: [PrismaModule, StorageModule],
     providers: [WidgetsService],
   })
   export class WidgetsModule {}
   ```

4. Inject `StorageService`:

   ```ts
   constructor(private readonly storage: StorageService) {}

   async saveAvatar(userId: string, file: Buffer) {
     return this.storage.upload(`avatars/${userId}.png`, file, 'image/png');
   }
   ```

Importing `StorageModule` while `STORAGE_DRIVER=none` is allowed so the API can
boot without optional uploads configured. Storage operations return a clear
service-unavailable response until a driver is enabled. Set `STORAGE_DRIVER=r2`
and configure the required credentials before using provider document uploads.

## API

| Method | Returns |
| --- | --- |
| `upload(key, body, contentType)` | Public URL |
| `store(key, buffer)` | `void` — uploads as `application/octet-stream` |
| `read(key)` | `Buffer` |
| `delete(key)` | `void` |
| `signedUploadUrl(key, contentType, expiresIn?)` | Presigned PUT URL (default 300s) |
| `signedDownloadUrl(key, expiresIn?, filename?)` | Presigned GET URL, `Content-Disposition: attachment` |
| `publicUrl(key)` | `${STORAGE_PUBLIC_URL}/${key}` |

Prefer `signedUploadUrl` for user uploads — it keeps large files off the API
process entirely.

## Turning it off

Set `STORAGE_DRIVER=none` to disable uploads. To drop storage permanently,
remove the `StorageModule` imports, delete `src/storage/`, and uninstall `@aws-sdk/client-s3` and
`@aws-sdk/s3-request-presigner`.
