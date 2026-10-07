import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Desktop supplies writable data and read-only resource paths; the CLI keeps its repo defaults. */
export function runtimePaths(env: Record<string, string | undefined> = process.env) {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const data = env.STREAMHUB_DATA_DIR || root;
  return {
    env: join(data, '.env'),
    secrets: join(data, '.streamhub/secrets.json'),
    dashboard: env.STREAMHUB_DASHBOARD_DIR || join(root, 'apps/dashboard/dist'),
    proto:
      env.STREAMHUB_PROTO_PATH || join(root, 'apps/hub/src/connectors/youtube/stream_list.proto'),
  };
}
