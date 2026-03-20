import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blogCollection = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    cover: z.string().optional(),
    author: z.string().optional().default("Tuo Lei"),
    authorUrl: z.string().optional().default("https://tuo-lei.com"),
    date: z.date(),
    readTime: z.string(),
    draft: z.boolean().optional().default(false),
  }),
});

export const collections = {
  blog: blogCollection,
};
