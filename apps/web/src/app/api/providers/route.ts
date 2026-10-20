import { json } from "@/server/http";
import { describeProviders } from "@/server/services";

export const runtime = "nodejs";

export function GET() {
  return json({ providers: describeProviders() });
}
