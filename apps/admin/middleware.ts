import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE_NAME = "aptamind_auth";

export function middleware(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return new NextResponse("No ADMIN_PASSWORD set", { status: 500 });
  }

  const cookie = request.cookies.get(COOKIE_NAME);
  const hasValidCookie = cookie?.value === password;

  if (request.nextUrl.pathname.startsWith("/api/")) {
    if (hasValidCookie) return NextResponse.next();
    return new NextResponse("API Unauthorized", { status: 401 });
  }

  if (hasValidCookie) {
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
          const response = NextResponse.next();
          response.cookies.set(COOKIE_NAME, password, {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/",
            maxAge: 60 * 60 * 24 * 7,
          });
          return response;
        }
        return new NextResponse(`Auth failed. Expected length ${password.length}, got ${pass.length}`, { status: 401 });
      } catch {
        return new NextResponse("Bad auth encoding", { status: 401 });
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
