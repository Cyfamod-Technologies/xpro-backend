# Plan: switch outbound email to Hostinger SMTP

This plan covers the backend repository only. It assumes a **Hostinger Email**
mailbox; confirm the SMTP details in hPanel under **Emails → Manage → Connect
Apps & Devices** before deployment. Titan or cPanel email may use different
settings. The backend code is implemented; production mailbox, DNS and secrets
must be configured during rollout.

## 1. Check the mailbox and sending domain

- Create or select a dedicated mailbox for transactional mail. Record its full
  address and mailbox password in the deployment secret store, not in Git.
- Confirm the mailbox's plan and rolling daily sending limit against expected
  verification, password reset, welcome, and staff invite volume. Hostinger
  limits vary by plan.
- Set `EMAIL_FROM` to that mailbox or an explicitly permitted alias. Keep
  `EMAIL_REPLY_TO` as needed. Verify the domain's SPF, DKIM, and DMARC records
  using values shown in hPanel. Merge SPF authorizations into the existing SPF
  record while both senders are active. MX changes affect incoming mail; if
  Hostinger requires its MX records to activate the mailbox while incoming
  mail stays elsewhere, confirm a supported setup or use a sending subdomain.
- Confirm the backend host can reach Hostinger's SMTP endpoint on the selected
  port. Hostinger Email lists `smtp.hostinger.com` with implicit TLS on port 465;
  port 587 with STARTTLS is the alternative.

Hostinger references: [SMTP connection settings](https://support.hostinger.com/en/articles/1575756-how-to-get-email-account-configuration-details-for-hostinger-email),
[domain DNS setup](https://support.hostinger.com/en/articles/8650765-set-up-a-domain-for-hostinger-email),
[plan limits](https://support.hostinger.com/en/articles/4625828-parameters-and-limits-of-hostinger-email).

## 2. Replace the backend transport

1. In `package.json` and `package-lock.json`, add `nodemailer` and its TypeScript
   types, then remove `zeptomail`.
2. In `src/email/email.service.ts`, replace `SendMailClient` with a Nodemailer
   transporter. Keep the `sendQueuedEmail(QueuedEmail): Promise<SentEmailResult>`
   contract and existing rendering, sender name, reply-to, and masked logging.
   Map the rendered subject, HTML, and plain text into `sendMail`; retain the
   notification ID in a message header for tracing. Return an SMTP provider
   label and Nodemailer's `messageId`.
3. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASSWORD`. Use
   `secure: true` for 465; for 587 use STARTTLS and require the upgrade so mail
   is never sent over a plaintext connection. Set connection and socket
   timeouts. Keep development bootable without SMTP credentials, but fail a
   send clearly when they are absent.
4. In `src/config/env.validation.ts`, replace the production ZeptoMail token
   requirement with SMTP host, user, password, and a valid port. Preserve the
   existing production email and HTTPS checks. Validate that the configured
   sender is a real mailbox or an authorized alias during rollout.

No Prisma migration or change to `NotificationsService`, `EmailProcessor`,
templates, or route handlers is planned. The existing BullMQ retry and
notification status flow continues to apply.

## 3. Update backend configuration and documentation

- Replace `ZEPTOMAIL_URL` and `ZEPTOMAIL_TOKEN` in `.env.example` with the SMTP
  variables. Document `smtp.hostinger.com`, port 465, and the full mailbox
  address as `SMTP_USER`; leave the password blank.
- Update `docs/email/README.md`, `docs/email/smtp.md`, and
  `docs/deployment.md` so Hostinger SMTP is the active transport and the
  production checklist matches `validateEnv`. Keep the ZeptoMail guide clearly
  marked as historical if retained.
- Populate the backend deployment's secret store or `.env.prod` with the new
  values. `docker-compose.prod.yml` already passes `.env.prod` through
  `env_file`, so no Compose change is expected.

## 4. Verify before and after release

1. Add unit tests for SMTP option selection (465 and 587), sender/reply-to,
   HTML and text, notification ID header, success `messageId`, missing config,
   and transport errors. Add production env validation tests for missing or
   invalid SMTP settings. Mock Nodemailer; do not send real mail in CI.
2. Run the backend gates: `npm run lint`, `npm test -- --runInBand`, and
   `npm run build`. Review the lockfile diff and search for remaining runtime
   ZeptoMail references.
3. In staging, send a verification or password reset email through the normal
   API flow. Confirm the recipient gets both a valid message and the expected
   links/code; inspect SPF, DKIM, and DMARC results in the received message.
   Confirm the `Notification` row reaches `sent` and failures reach
   `retrying`/`failed` as expected. An SMTP acceptance means the server accepted
   the message; inbox delivery still needs checking.
4. Deploy backend code and SMTP secrets together. Watch SMTP authentication and
   rate-limit errors, queue depth, `Notification` failures, and real inbox
   delivery. Keep ZeptoMail credentials available until the new path is stable.

## Rollback

Redeploy the previous backend release with its ZeptoMail configuration and
credentials. Because queue jobs carry template data rather than provider data,
pending jobs will use the transport in the running release. Review failed jobs
before replaying them to avoid duplicate messages when SMTP accepted a message
but the worker lost its acknowledgment.
