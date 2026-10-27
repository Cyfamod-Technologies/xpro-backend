export type BootstrapAdminConfig = Readonly<{
  email: string;
  tokenSha256: string;
}>;

export const BOOTSTRAP_ADMIN_CONFIG = Symbol('BOOTSTRAP_ADMIN_CONFIG');

export const bootstrapAdminConfig: BootstrapAdminConfig = {
  email: 'admin@xpro.test',
  tokenSha256:
    '9ab70c1b6b811eda4b5c59232923683cbcad817b2fea88a9819bd79e995b9a70',
};
