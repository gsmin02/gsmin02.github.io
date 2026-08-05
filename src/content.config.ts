import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tag: z.enum(['AWS', 'ADsP', '파이썬', '회고']),
    summary: z.string(),
    readingMinutes: z.number().default(5),
  }),
});

export const collections = { blog };
