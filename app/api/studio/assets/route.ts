import { GET as _GET, POST as _POST } from "./_handlers";

export async function GET(req: Request) {
  return _GET(req);
}

export async function POST(req: Request) {
  return _POST(req);
}
