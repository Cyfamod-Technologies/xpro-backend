# Phone verification

Apply the additive `20261030100000_phone_verification` migration and regenerate
Prisma before starting the updated API and workers. Existing accounts receive
nullable phone fields. No existing phone is assumed verified or backfilled.

Admin Settings has a **Require provider phone verification** switch backed by
`provider.requirePhoneVerification`. It defaults to `false`, including when no
setting row exists, so a valid phone can be saved without SMS verification. Staff
with `settings.manage` can change it using the normal reason, version check, audit
and settings history. Configure SMS delivery before enabling it. When enabled, all
providers, including previously approved providers, must verify their exact number
before submitting or saving a profile. Existing jobs are unaffected.

The admin API is owned by [PlatformSettingsModule](platform-settings.md) in
`src/platform-settings/`. Its controller serves the settings routes and its service
uses the shared settings persistence and history.

SMS delivery is provider-neutral and disabled until a service is chosen.
`SMS_PROVIDER=none` returns 503 when a code is requested, before creating a
challenge or changing the account phone. There is no fixed development code or
verification bypass.

When a service is chosen, implement the `SmsGateway` interface in `src/sms/`,
register its configuration key in `createSmsGateway`, and configure that provider
and its credentials in both the API and worker environments. An unregistered
`SMS_PROVIDER` fails at startup rather than silently disabling delivery. The
adapter must validate its required credentials and support Nigerian numbers.
`SmsService` delegates delivery through the `SMS_GATEWAY` injection token and
sanitizes gateway errors; the verification endpoints, worker and UI do not depend
on a particular vendor. Credentials remain on the server.

Authenticated routes (under the normal API prefix):

| Route                                 | Request                    | Response data                                                      |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| `POST /me/phone/verify/start`         | `{ phone }`                | `{ verificationId, phone: masked, expiresAt, resendAfter }`        |
| `POST /me/phone/verify/confirm`       | `{ verificationId, code }` | `{ phone, phoneVerified, phoneVerifiedAt }`                        |
| `GET /auth/me`                        | —                          | Account data including `phone`, `phoneVerified`, `phoneVerifiedAt` |
| `GET /providers/me/onboarding-policy` | —                          | `{ phoneVerificationRequired }`                                    |

Start normalizes Nigerian numbers, invalidates earlier challenges for the account,
and clears verification when the account number changes. Sending uses the `sms`
BullMQ queue through `JobsService`. Queue payloads encrypt the code, omit the full
phone, and are removed after completion or failure. Final failed-job records contain
only the verification id; request a new code rather than replaying a failed SMS.
Audit events omit both the number and code. Codes are hashed with HMAC-SHA256 in
the database and expire after ten minutes. Five wrong attempts consume the code.

Limits: one send per sixty seconds, five sends per rolling hour per user, ten per
rolling day per phone, and three distinct numbers per rolling day per user. Account
row locks serialize start/confirm/submission; a per-number advisory lock serializes
the shared phone quota. Resending supersedes the previous code. Confirmation is
scoped to the signed-in account and cannot replay a consumed code.

When the requirement is enabled, provider submission checks the verified account
number before external work and again under the account and policy locks before
saving. Policy writes and submissions use the same advisory lock, so enabling the
setting while a form is open cannot bypass the server gate. When disabled, saving
a changed phone clears verification and invalidates outstanding phone challenges.
The existing provider phone column
remains a normalized snapshot, synchronized on confirmation, for compatibility;
account phone verification is the authority. Editing an unsaved form number never
establishes verification.

The web provider form and Account screen reuse `PhoneVerificationField` and
`PhoneVerificationDialog`. Drafts can be saved without verification; submitting a
provider profile requires the exact verified account number only when the setting
is enabled. The form reads the policy on load and before submission, and blocks
submission with a retry action if the policy cannot be fetched. Demo onboarding keeps
its existing behavior and does not send SMS.

Validation: run the phone integration tests against `DATABASE_URL_TEST`, a dedicated
database whose name contains `test`, using `npm run test:int -- phone-verification`.
The integration harness applies migrations only to that test database. Tests mock
the SMS queue and send no real messages.
