import { createHandler } from "./handler.ts";

const project = new URL(Deno.env.get("SUPABASE_URL") ?? "");
const configured = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as
  | Record<string, string>
  | null;
const secret = configured?.default;
const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const headers: Record<string, string> = {
  "Content-Type": "application/json",
};
if (secret?.startsWith("sb_secret_")) {
  headers.apikey = secret;
} else if (legacy?.startsWith("eyJ")) {
  headers.apikey = legacy;
  headers.Authorization = "Bearer " + legacy;
} else {
  throw Error("KinoTix pairing credentials are unavailable");
}

Deno.serve(createHandler(project, async (name, args) => {
  const response = await fetch(new URL("/rest/v1/rpc/" + name, project), {
    method: "POST",
    headers,
    body: JSON.stringify(args),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error("KinoTix pairing database unavailable");
  return await response.json();
}));
