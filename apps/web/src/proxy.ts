import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Paths behind the optimistic auth redirect. Every other matched request just
// gets the nonce + CSP without an auth gate.
const PROTECTED_PATHS = ["/app", "/onboarding"];

function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";

  // style-src keeps 'unsafe-inline' instead of the docs' nonce-based styles:
  // nonces can't attach to React `style` attributes, so they'd be blocked.
  // 'unsafe-eval' (React dev error stacks) and ws:/wss: (HMR) are dev-only;
  // upgrade-insecure-requests is prod-only so local http/ws isn't upgraded.
  const cspHeader = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""};
    style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data: https:;
    media-src 'self' blob:;
    font-src 'self';
    connect-src 'self'${isDev ? " ws: wss:" : ""};
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    ${isDev ? "" : "upgrade-insecure-requests;"}
  `;
  // Replace newline characters and spaces
  return cspHeader.replace(/\s{2,}/g, " ").trim();
}

function routeResponse(request: NextRequest, requestHeaders: Headers): NextResponse {
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );

  // Optimistic redirect only — the session cookie may be stale or invalid, so
  // every protected route still verifies the session server-side.
  if (isProtected && !getSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    return NextResponse.redirect(url);
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export function proxy(request: NextRequest) {
  // Fresh nonce per request: Next.js parses it back out of the forwarded
  // request CSP header at render time and stamps it on its own script tags.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const contentSecurityPolicyHeaderValue = contentSecurityPolicy(nonce);

  // Forwarded on the request so SSR sees the nonce; x-nonce keeps it reachable
  // via headers() for any future custom <Script>.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicyHeaderValue);

  const response = routeResponse(request, requestHeaders);
  response.headers.set("Content-Security-Policy", contentSecurityPolicyHeaderValue);
  return response;
}

export const config = {
  matcher: [
    /*
     * All document requests except API routes, _next static/image assets,
     * favicon and files with an extension (public/*). Prefetch/RSC requests
     * are skipped — no HTML document means nothing needs a nonce.
     */
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
