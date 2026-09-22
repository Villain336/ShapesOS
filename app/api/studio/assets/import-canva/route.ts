import { importCanvaHandler } from "../_handlers";

export async function POST(req: Request) {
  return importCanvaHandler(req);
}
