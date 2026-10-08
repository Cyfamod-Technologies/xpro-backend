# ZeptoMail

The configured provider. ZeptoMail (Zoho) is transactional-only — it will not
accept marketing sends, which is part of why its deliverability is good.

## 1. Add and verify a domain

ZeptoMail console → **Mail Agents → Domains → Add Domain**.

Add the DNS records it gives you:

| Record | Purpose |
| --- | --- |
| `TXT` (verification) | Proves domain ownership |
| `TXT` (SPF) | Authorises ZeptoMail to send as your domain |
| `CNAME` ×2 (DKIM) | Signs your mail |

Verification usually completes in minutes; DNS propagation can take longer. Do not
skip DKIM — unsigned mail lands in spam.

Also add a `DMARC` record once SPF and DKIM pass:

```
_dmarc.example.com  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
```

Start at `p=none`, read the reports, then tighten to `quarantine` or `reject`.

## 2. Create a Mail Agent and token

**Mail Agents → Create Mail Agent** (one per app or environment), then open it and
copy the **Send Mail Token** from **SMTP & API → API**.

The token is shown as `Zoho-enczapikey xxxxx...`. Keep the whole string including
the prefix — the `zeptomail` SDK expects it.

## 3. Configure

```bash
ZEPTOMAIL_URL=https://api.zeptomail.com/v1.1/email
ZEPTOMAIL_TOKEN=Zoho-enczapikey xxxxxxxxxxxxxxxxxxxx
EMAIL_FROM=noreply@example.com
EMAIL_FROM_NAME=Acme
EMAIL_REPLY_TO=support@example.com
FRONTEND_URL=https://app.example.com
EMAIL_ASSET_BASE_URL=https://app.example.com/email/v1
EMAIL_SUPPORT_ADDRESS=support@example.com
```

Use `https://api.zeptomail.eu/v1.1/email` if your account is in the EU data centre —
sending to the wrong region returns 401 with an unhelpful message.

`EMAIL_FROM` must be on a domain verified in step 1.

## 4. Verify

```bash
npm run seed:sample-user -- --email you@example.com --password 'Str0ng!Pass'
# then trigger a real send:
curl -X POST http://localhost:4000/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'
```

Check the `notifications` table — `status` should reach `sent` with `sentAt` set.
`EmailProcessor` logs the provider message id on success.

## Implementation

`src/email/email.service.ts` uses the official `zeptomail` SDK:

```ts
this.client = new SendMailClient({ url: zeptoUrl, token: this.zeptoToken });
```

Two details worth knowing:

- `client_reference` is set to the `notificationId`, so a message in the ZeptoMail
  dashboard maps back to a row in your database.
- `track_clicks` and `track_opens` are **off**. Tracking rewrites links and injects
  a pixel, which hurts deliverability on transactional mail and has privacy
  implications. Turn them on deliberately, not by default.

Without a token the service logs a warning at construction and throws on send —
development and previews still work.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| 401 `invalid token` | Wrong data centre URL, or the `Zoho-enczapikey ` prefix was stripped |
| `TM_3201` unverified sender | `EMAIL_FROM` domain not verified, or a different domain than the Mail Agent |
| Mail lands in spam | DKIM CNAMEs missing or unpropagated; no DMARC record |
| Sends work locally, fail in prod | Production `validateEnv` rejects `example.com` and non-HTTPS URLs |
| Nothing sends, no error | Job stuck in the queue — check `failed_jobs` and that a worker is running |

## Limits

Transactional only. ZeptoMail credits are consumed per email, and daily caps apply
to new accounts until you build sending reputation. If you need bulk or marketing
sends, use a separate provider — do not route them through this transport.
