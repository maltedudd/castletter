import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Allow any HTTPS image source so podcast cover images from arbitrary CDNs
    // (e.g. podigee-cdn.net, podtrac.com, etc.) load without hotlink errors.
    // Next.js fetches the image server-side, which avoids Referer-based blocks
    // that CDNs use to prevent direct embedding from external domains.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
};

export default nextConfig;
