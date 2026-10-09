import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const novels = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/novels' }),
  schema: z.object({
    title: z.string(),
    part: z.string(),
    chapter: z.number(),
    // Optional publish date ("2026-10-08" or full ISO). The RSS feed needs a
    // date the repository can reproduce — see src/pages/rss.xml.js.
    published: z.string().optional(),
  }),
});

export const collections = { novels };