import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE_NAME = "aptamind_auth";

export function middleware(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return NextResponse.next();
  }

  // Allow API routes if the cookie is present (set by page login)
  const cookie = request.cookies.get(COOKIE_NAME);
  const hasValidCookie = cookie?.value === password;

  if (request.nextUrl.pathname.startsWith("/api/")) {
    if (hasValidCookie) return NextResponse.next();
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // For pages: accept cookie or Basic Auth
  if (hasValidCookie) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = atob(encoded);
      const [user, pass] = decoded.split(":");
      if (pass === password) {
        const response = NextResponse.next();
        response.cookies.set(COOKIE_NAME, password, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 60 * 24 * 7,
        });
        return response;
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
