// Cloudflare published edge IP ranges.
// Source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
// Snapshot: 2026-05-07. Update by hand when Cloudflare publishes a new list.
const cloudflareIpv4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

const cloudflareIpv6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const cloudflareIps = [...cloudflareIpv4, ...cloudflareIpv6];

// What Express's `trust proxy` honors. 'loopback', 'linklocal', 'uniquelocal' keep local
// dev and any LAN reverse proxy working without further config, and they are SAFE here
// because a proxy APPENDS to X-Forwarded-For and Express walks that chain right-to-left,
// so a client-supplied value can never end up as the resolved address.
//
// NOTE: this list is deliberately NOT the gate for CF-Connecting-IP. That header carries
// no chain — a local proxy passes through whatever single value the client sent — so
// services/activity.js gates it on `cloudflareIps` alone. See the comment there.
const trustedProxies = ['loopback', 'linklocal', 'uniquelocal', ...cloudflareIps];

module.exports = { cloudflareIpv4, cloudflareIpv6, cloudflareIps, trustedProxies };
