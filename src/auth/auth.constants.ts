/**
 * Name of the httpOnly cookie carrying the session token. Shared by the
 * controller that sets it and the JWT strategy that reads it, so renaming the
 * cookie is a one-line change.
 */
export const SESSION_COOKIE_NAME = 'xpro_session';
