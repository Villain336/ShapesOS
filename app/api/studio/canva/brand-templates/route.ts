import { listBrandTemplatesHandler } from "../_handlers";

export async function GET(req: Request) {
  return listBrandTemplatesHandler(req);
}
