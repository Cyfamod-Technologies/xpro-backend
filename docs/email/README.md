# Email

| Guide | When |
| --- | --- |
| [smtp.md](smtp.md) | Hostinger Email SMTP — the configured transport |
| [zeptomail.md](zeptomail.md) | Historical ZeptoMail setup guide |

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

The transport implementation lives in `email.service.ts`. Renderer, templates,
queueing and the `Notification` record are transport-agnostic. A provider switch
also needs matching environment validation, dependencies and deployment secrets.

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

Six ship with the template:

| Key | Payload |
| --- | --- |
| `welcome` | `{ firstName }` |
| `email_verification` | `{ token, firstName? }` |
| `password_reset` | `{ resetToken, firstName? }` |
| `custom_email` | `{ subject, preheader?, html, text }` |
| `staff_invite` | `{ name, token, expiresAt }` |
| `request_update` | `{ title, message, link? }` (`link` is a frontend path) |

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
| `logoUrl` | `${FRONTEND_URL}/images/xpro-logo-transparent.png` |
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

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASSWORD` set; port 465 or 587
- `EMAIL_FROM`, `EMAIL_FROM_NAME`, `FRONTEND_URL`, `EMAIL_ASSET_BASE_URL` set
- All URL variables absolute HTTPS
- `EMAIL_FROM` not on `example.com`

See [smtp.md](smtp.md) for Hostinger mailbox and domain setup.
