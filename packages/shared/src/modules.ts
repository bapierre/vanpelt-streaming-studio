import { z } from 'zod';

export const ModuleIdSchema = z.string().regex(/^[a-z0-9-]+$/, 'use lowercase letters, digits and dashes').max(40);

/** `modules/<id>/manifest.json` for a module with overlays. See ARCHITECTURE.md §7. */
export const ModuleManifestSchema = z.object({
  id: ModuleIdSchema,
  name: z.string().min(1).max(80),
  version: z.string().max(40),
  /** Folder with the built pages, relative to the module folder. */
  web: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/, 'use a plain relative folder')
    .default('dist'),
  overlays: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/).max(40),
        name: z.string().min(1).max(80).optional(),
        path: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*\.html(\?[\w=&%-]*)?$/, 'use a relative .html path')
          .max(200),
        width: z.number().int().positive().max(7680),
        height: z.number().int().positive().max(4320),
      }),
    )
    .min(1)
    .max(20),
  /** Topics the module's pages may receive: exact types or `prefix.` */
  subscribes: z.array(z.string().min(1).max(100)).max(50).default([]),
  /** Types the module may publish; always under `module.<id>.` */
  publishes: z.array(z.string().min(1).max(100)).max(50).default([]),
});
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

export const ModulesListSchema = z.object({
  modules: z
    .array(
      z.object({
        id: ModuleIdSchema,
        name: z.string(),
        version: z.string(),
        /** False when the module's pages are not built yet. */
        built: z.boolean(),
        overlays: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            /** Paste this into an OBS Browser Source. */
            url: z.string(),
            width: z.number(),
            height: z.number(),
          }),
        ),
      }),
    )
    .max(100),
});
export type ModulesList = z.infer<typeof ModulesListSchema>;
