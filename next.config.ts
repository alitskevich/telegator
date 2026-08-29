import type { NextConfig } from "next";

/**
 * §9.3 L814 deploys this on Amplify Hosting with platform `WEB_COMPUTE`, so the
 * default server output is exactly what is wanted here — no `output: "export"`,
 * which would strip the server actions of §8.4, and no `standalone`, which
 * Amplify's build image does not consume.
 */
const nextConfig: NextConfig = {
  // §8.2's route tree is small and fully enumerated, so typed hrefs cost
  // nothing and catch a renamed route at `tsc` rather than at a 404.
  typedRoutes: true,

  // The dashboard renders live DynamoDB and CloudWatch reads (§8.3). A cached
  // page would show a queue depth or a `zeroYieldRuns` count from some earlier
  // request, which is precisely the number an operator is on this page to check.
  // Individual pages opt in to `force-dynamic`; this only stops the build from
  // silently prerendering one that forgot.
  experimental: {
    staleTimes: { dynamic: 0, static: 0 },
  },
};

export default nextConfig;
