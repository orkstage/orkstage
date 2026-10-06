import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/**
 * Static export: the whole site (landing, docs, search index, sitemap) is plain files in `out/`,
 * served from S3 behind CloudFront. No server routes, no image optimizer.
 * `trailingSlash` makes every route a `<route>/index.html`, which S3 + a CloudFront function
 * can serve without rewrites per page (see infra/README.md).
 */
/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
};

export default withMDX(config);
