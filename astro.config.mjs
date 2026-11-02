// Webflow Cloud sets the base path from the environment's mount path and adds the
// Cloudflare adapter at build time. Do not set base or assetsPrefix here.
import { defineConfig, passthroughImageService } from 'astro/config';
export default defineConfig({
  output: 'server',
  image: { service: passthroughImageService() },
});
