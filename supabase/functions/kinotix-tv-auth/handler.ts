const functionName = "kinotix-tv-auth";
const publicPath = "/functions/v1/" + functionName;
const runtimePath = "/" + functionName;
const expiresIn = 300;
const maxBodyBytes = 1024;
const idPattern = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const digestPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const codePattern = /^[A-Za-z0-9._~-]{8,512}$/;
const text = new TextEncoder();

type Rpc = (
  name: string,
  args: Record<string, string | null>,
) => Promise<unknown>;

const commonHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function json(
  value: Record<string, unknown>,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return Response.json(value, {
    status,
    headers: { ...commonHeaders, ...extra },
  });
}

function page(message: string, status = 200): Response {
  return new Response(message, {
    status,
    headers: { ...commonHeaders, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function redirect(target: URL, status = 303): Response {
  return new Response(null, {
    status,
    headers: { ...commonHeaders, Location: target.href },
  });
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/, "");
}

function token(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function secretHash(secret: string): Promise<string> {
  return base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(secret))),
  );
}

function route(pathname: string): string[] {
  for (const prefix of [publicPath, runtimePath]) {
    if (pathname.startsWith(prefix + "/")) {
      return pathname.slice(prefix.length + 1).split("/");
    }
  }
  return [];
}

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.test(value);
}

async function readBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const type = request.headers.get("content-type")?.split(";")[0].trim()
    .toLowerCase();
  const length = Number(request.headers.get("content-length") || "0");
  if (
    type !== "application/json" || !request.body ||
    !Number.isSafeInteger(length) || length < 0 || length > maxBodyBytes
  ) return null;
  const bytes = new Uint8Array(maxBodyBytes);
  const reader = request.body.getReader();
  let size = 0;
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 4000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > bytes.length) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    if (expired) return null;
    const result: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
    return result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown>
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
}

export function createHandler(project: URL, rpc: Rpc) {
  if (
    project.protocol !== "https:" ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(project.hostname) ||
    project.username || project.password || project.port ||
    project.pathname !== "/" || project.search || project.hash
  ) throw Error("Invalid KinoTix project URL");
  const root = new URL(publicPath + "/", project);
  const invalid = () => json({ status: "error" }, 400);
  const limited = (seconds: string) =>
    json({ status: "pending" }, 429, { "Retry-After": seconds });

  return async (request: Request): Promise<Response> => {
    if (request.url.length > 2048) return invalid();
    const url = new URL(request.url);
    const parts = route(url.pathname);
    const [action, id, phoneToken] = parts;

    try {
      if (
        parts.length === 1 && action === "start" && request.method === "POST"
      ) {
        const body = await readBody(request);
        if (
          !body || !matches(digestPattern, body.challenge) ||
          !matches(digestPattern, body.readHash)
        ) return invalid();

        const pairingId = token(16);
        const writeToken = token(32);
        const accepted = await rpc("kinotix_tv_pair_start", {
          p_id: pairingId,
          p_read_hash: body.readHash,
          p_write_hash: await secretHash(writeToken),
          p_challenge: body.challenge,
        });
        if (accepted === false) return limited("60");
        if (accepted !== true) throw Error("Invalid pairing response");
        return json({
          id: pairingId,
          url: new URL(`login/${pairingId}/${writeToken}`, root).href,
          expiresIn,
        }, 201);
      }

      if (
        parts.length === 1 && action === "poll" && request.method === "POST"
      ) {
        const body = await readBody(request);
        if (
          !body || !matches(idPattern, body.id) ||
          !matches(digestPattern, body.readToken)
        ) return invalid();
        const result = await rpc("kinotix_tv_pair_poll", {
          p_id: body.id,
          p_read_hash: await secretHash(body.readToken),
        }) as { status?: unknown; code?: unknown } | null;
        if (result?.status === "rate_limited") return limited("2");
        if (
          result?.status === "ready" && matches(codePattern, result.code)
        ) return json({ status: "ready", code: result.code });
        if (
          result?.status === "pending" || result?.status === "expired" ||
          result?.status === "error"
        ) return json({ status: result.status });
        throw Error("Invalid polling response");
      }

      if (parts.length === 1 && request.method === "GET") {
        if (action === "done") {
          return page(
            "Anmeldung bestätigt. Du kannst am Fernseher weitermachen.",
          );
        }
        if (action === "failed") {
          return page(
            "Die Anmeldung wurde abgebrochen oder ist abgelaufen. Starte sie am Fernseher erneut.",
          );
        }
      }

      if (
        parts.length === 3 && request.method === "GET" &&
        matches(idPattern, id) && matches(digestPattern, phoneToken)
      ) {
        const writeHash = await secretHash(phoneToken);
        if (action === "login") {
          const challenge = await rpc("kinotix_tv_pair_challenge", {
            p_id: id,
            p_write_hash: writeHash,
          });
          if (!matches(digestPattern, challenge)) {
            return redirect(new URL("failed", root));
          }
          const authorize = new URL("/auth/v1/authorize", project);
          authorize.search = new URLSearchParams({
            provider: "google",
            redirect_to: new URL(`callback/${id}/${phoneToken}`, root).href,
            code_challenge: challenge,
            code_challenge_method: "s256",
            prompt: "select_account",
          }).toString();
          return redirect(authorize, 302);
        }
        if (action === "callback") {
          const codes = url.searchParams.getAll("code");
          const code = codes.length === 1 && matches(codePattern, codes[0]) &&
              !url.searchParams.has("error")
            ? codes[0]
            : null;
          const accepted = await rpc("kinotix_tv_pair_complete", {
            p_id: id,
            p_write_hash: writeHash,
            p_code: code,
          });
          return redirect(
            new URL(accepted === true && code ? "done" : "failed", root),
          );
        }
      }

      return page("Diese Anmeldeseite wurde nicht gefunden.", 404);
    } catch {
      if (request.method === "POST") return json({ status: "error" }, 503);
      return page(
        "Die KinoTix-Anmeldung ist gerade nicht erreichbar. Versuche es am Fernseher erneut.",
        503,
      );
    }
  };
}
