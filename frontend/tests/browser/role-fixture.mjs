// Loopback-only Supabase contract fixture for exercising real server-rendered role UI.
// This is used by browser tests, never imported by the application.
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const users = {
  publisher: { id: "10000000-0000-4000-8000-000000000001", email: "user@example.test", display_name: "Alex Morgan", role: "publisher", is_active: true },
  admin: { id: "10000000-0000-4000-8000-000000000002", email: "admin@example.test", display_name: "Alex Morgan", role: "admin", is_active: true },
  viewer: { id: "10000000-0000-4000-8000-000000000003", email: "viewer@example.test", display_name: "Alex Morgan", role: "viewer", is_active: true },
};

export function roleCookie(role, origin = "http://127.0.0.1:3011") {
  const user = users[role];
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp: expires, iat: expires - 3600 })}`;
  const token = `${payload}.${createHmac("sha256", "local-browser-fixture-only").update(payload).digest("base64url")}`;
  return { name: "sb-127-auth-token", value: `base64-${encode({ access_token: token, refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600, expires_at: expires, user: { ...user, aud: "authenticated" } })}`, url: origin };
}

export async function startRoleFixture(port = 3012) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    let subject;
    try { subject = JSON.parse(Buffer.from(request.headers.authorization.split(" ")[1].split(".")[1], "base64url").toString()).sub; } catch { /* Signed-out request. */ }
    const user = Object.values(users).find((entry) => entry.id === subject);
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/auth/v1/user") {
      response.statusCode = user ? 200 : 401;
      response.end(JSON.stringify(user ? { ...user, aud: "authenticated", created_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {} } : { message: "No session" }));
    } else if (url.pathname === "/rest/v1/app_user") {
      response.end(JSON.stringify(user ?? null));
    } else if (url.pathname === "/auth/v1/.well-known/jwks.json") {
      response.end(JSON.stringify({ keys: [] }));
    } else {
      response.end("[]");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}

// Start an isolated local app: node tests/browser/role-fixture.mjs [--production]
// Public environment values point only to this fixture. No authentication bypass is added to app code.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startRoleFixture();
  const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", process.argv.includes("--production") ? "start" : "dev", "--hostname", "127.0.0.1", "--port", "3011"], {
    cwd: new URL("../../", import.meta.url), stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3012", SUPABASE_URL: "http://127.0.0.1:3012", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-ui-fixture", NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-ui-fixture", SUPABASE_SERVICE_ROLE_KEY: "local-ui-fixture", SUPABASE_PUBLISHABLE_KEY: "local-ui-fixture", SUPABASE_ANON_KEY: "local-ui-fixture" },
  });
  app.on("exit", (code) => { fixture.close(); process.exitCode = code; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { app.kill(); fixture.close(); });
}
