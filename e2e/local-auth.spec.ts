import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

const issuer = process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/bgp";

for (const username of ["designer1", "designer2"]) {
  test(`${username} signs into the Keycloak account page`, async ({ page }) => {
    await page.goto(`${issuer}/account/`);
    const signIn = page
      .getByRole("button", { name: "Sign in", exact: true })
      .or(page.getByRole("link", { name: "Sign in", exact: true }));
    if (await signIn.isVisible()) await signIn.click();
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(username);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${issuer}/account/`));
    await expect(page.getByRole("heading", { name: "Personal info", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Username", exact: true })).toHaveValue(
      username,
    );
  });
}

test("web client requires PKCE and issues access tokens for bgp-api", async ({ page, request }) => {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const redirect = "http://localhost:5173/t07-auth";
  let callbackUrl: string | undefined;
  // Capture the authorization redirect before navigation: no app server is needed in T07.
  await page.route(
    (url) => url.pathname.endsWith("/login-actions/authenticate"),
    async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status()).toBe(302);
      callbackUrl = response.headers().location;
      await route.fulfill({ status: 200, contentType: "text/html", body: "Local OIDC callback" });
    },
  );
  const authorize = new URL(`${issuer}/protocol/openid-connect/auth`);
  authorize.search = new URLSearchParams({
    client_id: "bgp-web",
    response_type: "code",
    redirect_uri: redirect,
    scope: "openid profile email",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  await page.goto(authorize.href);
  await page.getByLabel("Username or email").fill("designer1");
  await page.getByLabel("Password", { exact: true }).fill("designer1");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByText("Local OIDC callback", { exact: true })).toBeVisible();
  if (!callbackUrl) throw new Error("Missing authorization redirect");
  const callback = new URL(callbackUrl);
  expect(callback.origin + callback.pathname).toBe(redirect);
  expect(callback.searchParams.get("state")).toBe(state);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  if (!code) throw new Error("Missing authorization code");
  const tokens = await request.post(`${issuer}/protocol/openid-connect/token`, {
    form: {
      grant_type: "authorization_code",
      client_id: "bgp-web",
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
    },
  });
  expect(tokens.ok()).toBe(true);
  const tokenBody: { access_token?: unknown } = await tokens.json();
  if (typeof tokenBody.access_token !== "string") throw new Error("Missing access token");
  const payload = tokenBody.access_token.split(".")[1];
  if (!payload) throw new Error("Malformed access token");
  const claims: { aud?: unknown; iss?: unknown } = JSON.parse(
    Buffer.from(payload, "base64url").toString(),
  );
  expect(claims.iss).toBe(issuer);
  expect(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).toContain("bgp-api");

  authorize.searchParams.delete("code_challenge");
  authorize.searchParams.delete("code_challenge_method");
  const missingPkce = await request.get(authorize.href, { maxRedirects: 0 });
  expect(missingPkce.status()).toBe(302);
  expect(new URL(missingPkce.headers().location ?? redirect).searchParams.get("error")).toBe(
    "invalid_request",
  );
});
