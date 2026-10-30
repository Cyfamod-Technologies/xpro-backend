# Platform settings

`src/platform-settings/` owns the admin configuration API. `PlatformSettingsModule`
is registered in `AppModule` and contains the controller, service and validated
request DTOs. The admin Settings screen uses these existing routes:

| Route | Purpose | Permission |
| --- | --- | --- |
| `GET /admin/settings` | Read registered settings and effective defaults | Active staff |
| `PATCH /admin/settings` | Save a versioned change set with a reason | `settings.manage` |
| `GET /admin/settings/history` | Read change history, optionally filtered by key | `settings.manage` or `view.audit_sensitive` |

The API uses the normal authentication guard and response envelope.
`PlatformSettingsService` resolves the signed-in staff actor and delegates to
`src/platform/settings/SettingsService`, which provides shared persistence,
validation, version checks, audit history and reauthentication for high-risk
changes. Catalog and other feature modules continue to use that shared service.
There is one controller for the admin routes, owned by `PlatformSettingsModule`.

The provider email requirement is registered as `provider.requireEmailVerification`,
with a default of `true` so existing behavior is unchanged. It appears on the admin page
as **Require provider email verification**. When it is off, a provider whose email is
unverified can submit a profile. When it is on, submission is rejected with 403 `Verify
your email before submitting your provider profile.` The check runs before external work
and again under the account and policy locks, so turning the setting on while a form is
open cannot bypass it. `GET /providers/me/onboarding-policy` returns both
`emailVerificationRequired` and `phoneVerificationRequired`.

The provider phone requirement is registered as
`provider.requirePhoneVerification`, with a default of `false`. It appears on the
admin page as **Require provider phone verification**. It uses the existing
`settings` and `settings_history` tables; this module needs no new table or
migration. See [phone verification](phone-verification.md) for its effect on
provider submissions and SMS delivery configuration.
