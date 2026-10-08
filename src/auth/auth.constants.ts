/**
 * Name of the httpOnly cookie carrying the session token. Shared by the
 * controller that sets it and the JWT strategy that reads it, so renaming the
 * cookie is a one-line change. `npm run init` rewrites this for a new project.
 */
export const SESSION_COOKIE_NAME = 'app_session';
