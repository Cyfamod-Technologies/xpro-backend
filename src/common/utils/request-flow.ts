export type RequestFlow = 'v1' | 'phase2';

/** V1 is the launch flow; Phase 2 remains available by explicitly selecting it. */
export function requestFlowFrom(
  env: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
): RequestFlow {
  const configured = env['REQUEST_FLOW'];
  const value =
    typeof configured === 'string' ? configured.trim().toLowerCase() : 'v1';

  return value === 'phase2' ? 'phase2' : 'v1';
}
