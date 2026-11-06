// Designer sign-in for `bgp publish`: the OAuth 2.0 device authorization grant (RFC 8628)
// against the platform's OIDC provider. The CLI shows a link and a code; the designer signs in
// in any browser; the CLI polls for the token. Tokens stay in memory and are never printed.

/** The public OIDC client for the CLI (infra/keycloak/bgp-realm.json). */
export const DEFAULT_CLI_CLIENT_ID = "bgp-cli";
export const DEFAULT_ISSUER = "http://localhost:8080/realms/bgp";

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

function text(object: Fields | null, key: string): string | null {
  const value = object?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function httpUrl(object: Fields | null, key: string): string | null {
  const value = text(object, key);
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function seconds(object: Fields | null, key: string): number | null {
  const value = object?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

export interface DeviceSignIn {
  issuer: string;
  clientId: string;
  /** Shows the designer where to sign in. */
  prompt(verification: { url: string; code: string; completeUrl: string | null }): void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Runs the device authorization grant and returns an access token for the API. */
export async function signInWithDeviceCode(options: DeviceSignIn): Promise<string> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? wait;
  const issuer = options.issuer.replace(/\/$/, "");
  let config: Fields | null = null;
  try {
    config = fields(await json(await fetchImpl(`${issuer}/.well-known/openid-configuration`)));
  } catch {
    // Reported below.
  }
  const deviceEndpoint = httpUrl(config, "device_authorization_endpoint");
  const tokenEndpoint = httpUrl(config, "token_endpoint");
  if (!deviceEndpoint || !tokenEndpoint) {
    throw new SignInError(`Cannot reach the sign-in service at ${issuer}`);
  }
  const form = (values: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
  /** A request whose network failure becomes a SignInError. */
  const send = async (url: string, init: RequestInit) => {
    try {
      return await fetchImpl(url, init);
    } catch {
      throw new SignInError(`Cannot reach the sign-in service at ${issuer}`);
    }
  };
  const device = fields(
    await json(
      await send(
        deviceEndpoint,
        form({ client_id: options.clientId, scope: "openid profile email" }),
      ),
    ),
  );
  const deviceCode = text(device, "device_code");
  const userCode = text(device, "user_code");
  const verification = httpUrl(device, "verification_uri");
  const expiresIn = seconds(device, "expires_in");
  if (!deviceCode || !userCode || !verification || !expiresIn) {
    throw new SignInError(
      `The sign-in service refused device sign-in for client "${options.clientId}"`,
    );
  }
  options.prompt({
    url: verification,
    code: userCode,
    completeUrl: httpUrl(device, "verification_uri_complete"),
  });
  let interval = (seconds(device, "interval") ?? 5) * 1000;
  let remaining = expiresIn * 1000;
  while (remaining > 0) {
    await sleep(interval);
    remaining -= interval;
    const response = await send(
      tokenEndpoint,
      form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: options.clientId,
      }),
    );
    const body = fields(await json(response));
    const token = text(body, "access_token");
    if (response.ok && token) return token;
    const code = text(body, "error") ?? `HTTP ${response.status}`;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval += 5000;
      continue;
    }
    if (code === "access_denied") throw new SignInError("Sign-in was declined");
    if (code === "expired_token") break;
    throw new SignInError(`Sign-in failed (${code})`);
  }
  throw new SignInError("The sign-in code expired; run the command again");
}
