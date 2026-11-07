import { defineConfig } from 'astro/config';

// Static output for S3 + CloudFront. `site` is a placeholder until masalapos.com is live.
export default defineConfig({
  site: 'https://masalapos.example',
  output: 'static',
});
