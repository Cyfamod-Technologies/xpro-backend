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
