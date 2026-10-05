import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const novels = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/novels' }),
  schema: z.object({
    title: z.string(),
    part: z.string(),
    chapter: z.number(),
  }),
});

export const collections = { novels };