import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Dev only: Next 16 blocks dev-server requests from any host but localhost.
  // A phone on the same Wi-Fi opens the app by LAN IP, so allow private ranges.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*"],
};

export default nextConfig;
