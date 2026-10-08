# Email

| Guide | When |
| --- | --- |
| [zeptomail.md](zeptomail.md) | ZeptoMail — the configured provider |
| [smtp.md](smtp.md) | Generic SMTP — SES, Mailgun, Postmark, Resend, Gmail |

## Two layers

The split matters, because only one half is provider-specific:

```
NotificationsService.queueEmail()   → writes Notification row, enqueues `email` job
        ↓
EmailProcessor                      → consumes the job, updates row status
        ↓
EmailService                        → PROVIDER-SPECIFIC transport
        ↓
EmailRendererService                → template key + payload → subject/html/text
        ↓
templates/*.template.ts             → pure functions, no I/O
```

Switching providers touches **`email.service.ts` only**. Renderer, templates,
queueing and the `Notification` record are all transport-agnostic.

## Sending

Never call `EmailService` directly from a feature service — go through
`NotificationsService`, which creates the audit record and enqueues:

```ts
await this.notifications.queueEmail({
  recipientEmail: user.email,
  recipientUserId: user.id,
  type: 'password_reset',
  templateKey: 'password_reset',
  payload: { resetToken, firstName: user.firstName },
  cooldown: { key: `password_reset:${user.id}`, seconds: 60 },
});
```

`cooldown` is optional and backed by Redis — a second call with the same key
inside the window is dropped. Use it on anything a user can trigger repeatedly.

## Templates

Four ship with the template:

| Key | Payload |
| --- | --- |
| `welcome` | `{ firstName }` |
| `email_verification` | `{ code, firstName? }` |
| `password_reset` | `{ resetToken, firstName? }` |
| `custom_email` | `{ subject, preheader?, html, text }` |

`custom_email` injects `html` **without escaping**. Only ever populate it from
trusted server-side code, never from user input.

### Adding one

1. Add the key to `EMAIL_TEMPLATE_KEYS` in `email.types.ts`.
2. Add a payload interface and an entry in `EmailTemplatePayloadMap`.
3. Create `templates/<name>.template.ts` exporting a
   `(payload, context) => RenderedEmail` function.
4. Add a `case` and a payload mapper in `email-renderer.service.ts`.

The mapper re-validates every field with `requiredString` / `optionalString`,
because payloads arrive from the queue as untyped JSON.

## Branding

No product name is hardcoded in any template. `EmailRenderContext` carries:

| Field | Source |
| --- | --- |
| `appName` | `APP_NAME` (default `Xpro`) |
| `logoMark` | `EMAIL_LOGO_MARK`, or a monogram derived from `APP_NAME` |
| `frontendUrl` | `FRONTEND_URL` — normalised to its origin |
| `assetBaseUrl` | `EMAIL_ASSET_BASE_URL` |
| `supportEmail` / `privacyUrl` / `termsUrl` | Optional footer links |

Colours and the font stack live in `email-brand.constants.ts`. Inline styles are
required for mail-client support, so that file is the single place to restyle.

## Previewing

```bash
npm run email:preview            # all templates → .email-previews/
npm run email:preview welcome    # one template
```

No credentials needed — rendering is pure. Open the `.html` files in a browser.

## Delivery record

Every send writes a `Notification` row before queueing, moving
`queued → processing → sent | retrying | failed`. Jobs that exhaust retries are
also written to `FailedJob`. So a "did this email go out?" question is answerable
from the database without provider dashboard access.

## Production requirements

`validateEnv` enforces these when `NODE_ENV=production`:

- `ZEPTOMAIL_TOKEN` set
- `EMAIL_FROM`, `EMAIL_FROM_NAME`, `FRONTEND_URL`, `EMAIL_ASSET_BASE_URL` set
- All URL variables absolute HTTPS
- `EMAIL_FROM` not on `example.com`

If you switch to SMTP, update that check in `env.validation.ts` — see
[smtp.md](smtp.md).
