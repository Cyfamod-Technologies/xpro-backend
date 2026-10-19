-- Additive Xpro auth foundation. Keep the original template migration intact:
-- deployment history for shared databases has not yet been confirmed.

ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'unverified';
ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'pending_deletion';
ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'deactivated';
ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'deleted';

CREATE TYPE "PlatformRole" AS ENUM ('customer', 'provider', 'staff');
CREATE TYPE "WorkspaceRole" AS ENUM ('customer', 'provider');
CREATE TYPE "RoleAddedVia" AS ENUM ('signup', 'invite', 'self_service');
CREATE TYPE "ClientKind" AS ENUM ('web', 'mobile_ios', 'mobile_android');
CREATE TYPE "SessionRevokedReason" AS ENUM (
  'logout', 'logout_all', 'user_revoked', 'admin_revoked', 'password_changed',
  'password_reset', 'email_changed', 'mfa_reset', 'mfa_reenrolled', 'suspended',
  'deactivated', 'deletion_requested', 'role_changed', 'refresh_reuse', 'expired'
);
CREATE TYPE "AuthTokenPurpose" AS ENUM (
  'email_verify', 'password_reset', 'email_change', 'mfa_challenge', 'mfa_enrollment'
);
CREATE TYPE "LegalDocumentKind" AS ENUM ('terms', 'privacy', 'provider_agreement', 'staff_policy');
CREATE TYPE "StaffRole" AS ENUM ('super_admin', 'operations', 'pricing', 'client_relations', 'finance');
CREATE TYPE "StaffStatus" AS ENUM ('invited', 'active', 'suspended', 'deactivated', 'revoked');
CREATE TYPE "StaffInviteState" AS ENUM ('pending', 'consumed', 'superseded', 'revoked', 'expired');

ALTER TABLE "users"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "status_reason" TEXT,
  ADD COLUMN "status_changed_at" TIMESTAMP(3),
  ADD COLUMN "status_changed_by" TEXT,
  ADD COLUMN "password_changed_at" TIMESTAMP(3),
  ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "backoff_until" TIMESTAMP(3),
  ADD COLUMN "mfa_secret_enc" BYTEA,
  ADD COLUMN "mfa_pending_secret_enc" BYTEA,
  ADD COLUMN "mfa_pending_created_at" TIMESTAMP(3),
  ADD COLUMN "mfa_enrolled_at" TIMESTAMP(3),
  ADD COLUMN "mfa_last_step" BIGINT,
  ADD COLUMN "last_active_role" "WorkspaceRole",
  ADD COLUMN "deletion_requested_at" TIMESTAMP(3),
  ADD COLUMN "deletion_scheduled_for" TIMESTAMP(3),
  ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE TABLE "user_roles" (
  "user_id" TEXT NOT NULL,
  "role" "PlatformRole" NOT NULL,
  "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "added_via" "RoleAddedVia" NOT NULL,
  CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id", "role")
);
CREATE INDEX "user_roles_role_idx" ON "user_roles"("role");
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "sessions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "client" "ClientKind" NOT NULL,
  "device_id" TEXT,
  "device_label" TEXT NOT NULL,
  "ip_created" INET,
  "ip_last" INET,
  "user_agent" TEXT NOT NULL,
  "remember" BOOLEAN NOT NULL DEFAULT false,
  "active_role" "WorkspaceRole",
  "mfa_verified_at" TIMESTAMP(3),
  "reauth_at" TIMESTAMP(3),
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idle_expires_at" TIMESTAMP(3) NOT NULL,
  "absolute_expires_at" TIMESTAMP(3) NOT NULL,
  "permission_version_seen" INTEGER,
  "revoked_at" TIMESTAMP(3),
  "revoked_reason" "SessionRevokedReason",
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");
CREATE INDEX "sessions_idle_expires_at_idx" ON "sessions"("idle_expires_at");
CREATE INDEX "sessions_absolute_expires_at_idx" ON "sessions"("absolute_expires_at");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "refresh_tokens" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "token_hash" BYTEA NOT NULL,
  "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "superseded_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX "refresh_tokens_session_id_superseded_at_idx" ON "refresh_tokens"("session_id", "superseded_at");
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "auth_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "purpose" "AuthTokenPurpose" NOT NULL,
  "token_hash" BYTEA NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "created_ip" INET,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");
CREATE INDEX "auth_tokens_user_id_purpose_used_at_idx" ON "auth_tokens"("user_id", "purpose", "used_at");
CREATE INDEX "auth_tokens_expires_at_idx" ON "auth_tokens"("expires_at");
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "mfa_recovery_codes" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "code_hash" BYTEA NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mfa_recovery_codes_user_id_used_at_idx" ON "mfa_recovery_codes"("user_id", "used_at");
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "legal_documents" (
  "id" TEXT NOT NULL,
  "kind" "LegalDocumentKind" NOT NULL,
  "version" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "published_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "legal_documents_kind_version_key" ON "legal_documents"("kind", "version");
CREATE INDEX "legal_documents_kind_published_at_idx" ON "legal_documents"("kind", "published_at");

CREATE TABLE "legal_acceptances" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL,
  "ip_address" INET,
  "user_agent" TEXT,
  CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "legal_acceptances_user_id_document_id_key" ON "legal_acceptances"("user_id", "document_id");
CREATE INDEX "legal_acceptances_user_id_accepted_at_idx" ON "legal_acceptances"("user_id", "accepted_at");
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "legal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "account_status_history" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" "AccountStatus" NOT NULL,
  "reason" TEXT,
  "changed_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_status_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "account_status_history_user_id_created_at_idx" ON "account_status_history"("user_id", "created_at");
ALTER TABLE "account_status_history" ADD CONSTRAINT "account_status_history_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "staff_members" (
  "user_id" TEXT NOT NULL,
  "status" "StaffStatus" NOT NULL DEFAULT 'invited',
  "perm_version" INTEGER NOT NULL DEFAULT 1,
  "can_own_requests" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "staff_members_pkey" PRIMARY KEY ("user_id")
);
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "staff_member_roles" (
  "staff_user_id" TEXT NOT NULL,
  "role" "StaffRole" NOT NULL,
  "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_member_roles_pkey" PRIMARY KEY ("staff_user_id", "role")
);
CREATE INDEX "staff_member_roles_role_idx" ON "staff_member_roles"("role");
ALTER TABLE "staff_member_roles" ADD CONSTRAINT "staff_member_roles_staff_user_id_fkey"
  FOREIGN KEY ("staff_user_id") REFERENCES "staff_members"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "staff_invites" (
  "id" TEXT NOT NULL,
  "staff_user_id" TEXT NOT NULL,
  "token_hash" BYTEA NOT NULL,
  "state" "StaffInviteState" NOT NULL DEFAULT 'pending',
  "invited_by" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_invites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_invites_token_hash_key" ON "staff_invites"("token_hash");
CREATE INDEX "staff_invites_staff_user_id_state_idx" ON "staff_invites"("staff_user_id", "state");
CREATE INDEX "staff_invites_expires_at_idx" ON "staff_invites"("expires_at");
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_staff_user_id_fkey"
  FOREIGN KEY ("staff_user_id") REFERENCES "staff_members"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
