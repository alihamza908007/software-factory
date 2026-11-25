import { NextResponse, type NextRequest } from "next/server";
import { isCrossSite, safeEqual, sameOrigin } from "@/lib/core/request-guard";

const TOKEN_COOKIE = "factory_token";
const OPEN_API_PATHS = new Set(["/api/health"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function expectedToken(): string | undefined {
  const value = process.env.FACTORY_AUTH_TOKEN?.trim();
  return value || undefined;
}

function suppliedToken(request: NextRequest): string | undefined {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers.get("x-factory-token") ?? request.cookies.get(TOKEN_COOKIE)?.value;
}

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const expected = expectedToken();

  // One-time bootstrap: open /?token=… once and receive an HttpOnly cookie.
  // The token is stripped from the URL so it does not end up in history.
  const supplied = searchParams.get("token");
  if (supplied) {
    const url = request.nextUrl.clone();
    url.searchParams.delete("token");
    const response = NextResponse.redirect(url);
    if (expected && safeEqual(supplied, expected)) {
      response.cookies.set(TOKEN_COOKIE, supplied, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }
    return response;
  }

  if (!pathname.startsWith("/api")) {
    if (expected && pathname !== "/unlock") {
      const provided = suppliedToken(request);
      if (!provided || !safeEqual(provided, expected)) {
        return NextResponse.redirect(new URL("/unlock", request.url));
      }
    }
    return NextResponse.next();
  }

  if (OPEN_API_PATHS.has(pathname)) return NextResponse.next();

  if (MUTATING.has(request.method.toUpperCase())) {
    if (
      !sameOrigin(request.headers.get("origin"), request.headers.get("host")) ||
      isCrossSite(request.headers.get("sec-fetch-site"))
    ) {
      return NextResponse.json(
        { error: "Cross-site request blocked. Use the factory UI or a same-origin client." },
        { status: 403 },
      );
    }
  }

  if (expected) {
    const provided = suppliedToken(request);
    if (!provided || !safeEqual(provided, expected)) {
      return NextResponse.json(
        { error: "A valid factory token is required. Open /?token=… once or send Authorization: Bearer." },
        { status: 401 },
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  // Pages and API routes, but not Next internals or static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
