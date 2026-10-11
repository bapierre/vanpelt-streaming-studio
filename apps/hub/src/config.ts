import { z } from 'zod';

const blankToUndefined = (v: unknown) => (v === '' ? undefined : v);

const EnvSchema = z.object({
  HUB_PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(4747)),
  HUB_MODULES_PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(4748)),
  OBS_WS_URL: z.preprocess(blankToUndefined, z.string().default('ws://127.0.0.1:4455')),
  OBS_WS_PASSWORD: z.preprocess(blankToUndefined, z.string().default('')),
  // Production unless a dev script opts in: dev relaxes the WS Origin allowlist for Vite.
  NODE_ENV: z.preprocess(blankToUndefined, z.string().default('production')),
  TWITCH_CLIENT_ID: z.preprocess(blankToUndefined, z.string().trim().default('')),
});

export type HubConfig = {
  host: '127.0.0.1';
  port: number;
  modulesPort: number;
  obsUrl: string;
  obsPassword: string;
  dev: boolean;
  twitchClientId: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const e = EnvSchema.parse(env);
  return {
    host: '127.0.0.1',
    port: e.HUB_PORT,
    modulesPort: e.HUB_MODULES_PORT,
    obsUrl: e.OBS_WS_URL,
    obsPassword: e.OBS_WS_PASSWORD,
    dev: e.NODE_ENV === 'development',
    twitchClientId: e.TWITCH_CLIENT_ID,
  };
}
