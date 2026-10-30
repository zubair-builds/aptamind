import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return NextResponse.next();
  }

  const path = request.nextUrl.pathname;

  // Server-side fetches and health checks must not require browser auth.
  if (path.startsWith("/api/") || path === "/ready" || path === "/health") {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic" && encoded) {
      try {
        const decoded = atob(encoded);
        const colon = decoded.indexOf(":");
        const pass = colon >= 0 ? decoded.slice(colon + 1) : "";
        if (pass === password) {
          return NextResponse.next();
        }
      } catch {
        // fall through
      }
    }
  }

  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": "Basic realm=\"Aptamind Admin\"",
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
