// @ts-check
import { defineConfig } from 'astro/config';
import remarkNaturalParagraphs from './src/plugins/remark-natural-paragraphs.mjs';
import remarkCjkPunctHug from './src/plugins/remark-cjk-punct-hug.mjs';

export default defineConfig({
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
    // CSP 里 style-src 只允许 'self'，Vite 默认会把小体积的导入样式内联成 <style>。
    inlineStylesheets: 'never',
  },
  compressHTML: true,
  markdown: {
    remarkPlugins: [remarkNaturalParagraphs, remarkCjkPunctHug],
  },
});
