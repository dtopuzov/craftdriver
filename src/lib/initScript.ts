/** Reserved document path used only by the intercepted auth-state hydrator. */
export const AUTH_STATE_HYDRATE_PATH = '/__craftdriver_hydrate__';

/**
 * CraftDriver-owned preload scripts are public-page hooks. Keep them out of the
 * intercepted hydration document so they cannot mutate restored localStorage or
 * emit application traffic while auth state is being installed.
 */
export function publicPageInitScript(functionDeclaration: string): string {
  return `function () {
    if (location.pathname === ${JSON.stringify(AUTH_STATE_HYDRATE_PATH)}) return;
    return (${functionDeclaration}).apply(this, arguments);
  }`;
}
