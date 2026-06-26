interface GoogleKeyringCredential {
  token?: {
    access_token?: string;
  };
}

function parseCredential(credential: Buffer): GoogleKeyringCredential | undefined {
  const value = credential.toString("utf8").trim();
  const prefix = "go-keyring-base64:";
  try {
    const json = value.startsWith(prefix)
      ? Buffer.from(value.slice(prefix.length), "base64").toString("utf8")
      : value;
    return JSON.parse(json) as GoogleKeyringCredential;
  } catch {
    return undefined;
  }
}

async function fetchEmailFromUserInfo(accessToken: string): Promise<string | undefined> {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { email?: unknown };
  return typeof body.email === "string" ? body.email : undefined;
}

async function fetchEmailFromTokenInfo(accessToken: string): Promise<string | undefined> {
  const response = await fetch(
    `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
  );
  if (!response.ok) return undefined;
  const body = await response.json() as { email?: unknown };
  return typeof body.email === "string" ? body.email : undefined;
}

export async function detectCredentialEmail(
  credential: Buffer,
): Promise<string | undefined> {
  const accessToken = parseCredential(credential)?.token?.access_token;
  if (!accessToken) return undefined;
  try {
    return await fetchEmailFromUserInfo(accessToken)
      ?? await fetchEmailFromTokenInfo(accessToken);
  } catch {
    return undefined;
  }
}
