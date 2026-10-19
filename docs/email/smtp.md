# Hostinger Email SMTP

The backend sends all queued email through Nodemailer using SMTP. The renderer,
templates, BullMQ processor and `Notification` records are independent of the
mail provider.

These settings apply to **Hostinger Email**. If the mailbox is hosted by Titan
or cPanel, use the connection settings shown for that mailbox in hPanel.

## Mailbox and domain

1. Create a dedicated sending mailbox in Hostinger and note its full email
   address and mailbox password. The SMTP password is the mailbox password,
   not the Hostinger account password.
2. In hPanel, open **Emails → Manage → Connect Apps & Devices** to confirm the
   SMTP host, port and encryption for that mailbox.
3. Configure SPF, DKIM and DMARC for the sending domain using the values in
   hPanel. During a transition from another sender, keep both authorized in
   one SPF record. MX changes affect incoming mail; if Hostinger requires its
   MX records to activate this mailbox while incoming mail stays elsewhere,
   confirm a supported setup or use a dedicated sending subdomain.
4. Check the mailbox plan's daily sending limit against expected transactional
   volume. Limits vary by plan and apply over a rolling 24-hour period.

Hostinger's [connection settings](https://support.hostinger.com/en/articles/1575756-how-to-get-email-account-configuration-details-for-hostinger-email)
list `smtp.hostinger.com` on port 465 with implicit TLS. Port 587 with STARTTLS
is an alternative. See Hostinger's [domain setup](https://support.hostinger.com/en/articles/8650765-set-up-a-domain-for-hostinger-email)
and [plan limits](https://support.hostinger.com/en/articles/4625828-parameters-and-limits-of-hostinger-email)
for the current account requirements.

## Backend configuration

Set these environment variables on the backend server or in `.env.prod`:

```dotenv
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=noreply@your-domain.com
SMTP_PASSWORD=<mailbox-password>
EMAIL_FROM=noreply@your-domain.com
EMAIL_FROM_NAME=Xpro
EMAIL_REPLY_TO=support@your-domain.com
```

`EMAIL_FROM` should be the authenticated mailbox or an alias authorized for it.
`EMAIL_REPLY_TO` is optional. Keep credentials in deployment secrets, never in
Git. `docker-compose.prod.yml` already passes `.env.prod` to the API container.

The backend uses implicit TLS on port 465. On port 587 it requires STARTTLS;
the send fails if the server cannot upgrade the connection. Production boot
requires the four `SMTP_*` variables, allows only ports 465 and 587, and still
requires the existing email branding and HTTPS URL variables. Development can
boot without SMTP settings, but a send then fails and is recorded by the email
job processor.

## Verify a send

Trigger a normal verification or password reset email in staging. Check that:

- The message reaches the intended inbox with the expected code or link, HTML
  and plain-text content, sender and reply-to address.
- The received message passes SPF, DKIM and DMARC checks.
- The matching `Notification` row moves to `sent`. SMTP rejection should move
  it through `retrying` and eventually `failed`, with a `FailedJob` record.

The SMTP server's acceptance means it accepted responsibility for the message;
it does not prove inbox delivery. The service logs a masked recipient and the
SMTP `messageId`, while the `X-Notification-Id` header links the message to the
backend record.

If authentication fails, verify the full mailbox address and mailbox password.
If connection or TLS setup fails, compare the selected port and encryption with
hPanel, then check outbound access from the backend host. If sending fails after
some successful messages, check the mailbox's plan limit and the email queue.
