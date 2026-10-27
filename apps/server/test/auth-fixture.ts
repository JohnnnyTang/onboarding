import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";

export const TEST_SECRET = "authentication-test-secret-with-at-least-32-bytes";

/** Real HTTP JWKS; no signature verification or remote-key code is mocked. */
export async function startIssuer() {
  const pair = await generateKeyPair("RS256");
  const wrongPair = await generateKeyPair("RS256");
  const publicKey = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [publicKey] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${address.port}`;
  const oidc = { issuer, audience: "bgp-api", jwksUrl: `${issuer}/jwks` };
  async function token(overrides: JWTPayload = {}, wrongSignature = false) {
    return new SignJWT({ name: "Designer One", email: "one@example.test", ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
      .setIssuer(overrides.iss ?? issuer)
      .setAudience(overrides.aud ?? "bgp-api")
      .setSubject(overrides.sub ?? "designer-1")
      .setIssuedAt()
      .setExpirationTime(overrides.exp ?? "5m")
      .sign(wrongSignature ? wrongPair.privateKey : pair.privateKey);
  }
  return {
    oidc,
    token,
    privateKey: pair.privateKey,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
