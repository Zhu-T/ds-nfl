/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle with only the node_modules it actually
  // needs, so the app can be shipped without the repo or an npm install.
  output: 'standalone',
  // The workspace root is two levels up; without this Next traces file
  // dependencies from apps/web and misses the hoisted node_modules.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname.slice(1),

  // @ds-nfl/core ships TypeScript source rather than a build artifact, so Next
  // compiles it as part of the app. Keeps the engine editable without a watch build.
  transpilePackages: ['@ds-nfl/core', '@ds-nfl/adapters', '@ds-nfl/llm'],

  // next/image is unused, and its optimizer pulls in sharp plus platform binaries
  // (~19 MB) that would otherwise be shipped in the desktop build for nothing.
  images: { unoptimized: true },

  // TypeScript is a build tool. It gets traced in because the workspace packages
  // ship .ts source, but it has no business in a production server bundle.
  //
  // Only genuinely build-only packages belong here. @swc/** was excluded on a
  // first pass and broke the packaged app at startup: Next requires
  // @swc/helpers at *runtime*, and tracing had included it correctly.
  // apps/desktop holds the packaging output, including a staged copy of this
  // very build. Tracing from the workspace root would otherwise pull it in and
  // the bundle would grow by its own size on every run.
  outputFileTracingExcludes: {
    '*': ['node_modules/typescript/**', 'apps/desktop/**', '**/*.test.ts'],
  },

  webpack: (config) => {
    // The engine's internal imports carry explicit `.js` extensions so it stays
    // valid under Node's ESM resolution (it will run outside the bundler in the
    // automation process later). Webpack needs to be told those map to `.ts`.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
