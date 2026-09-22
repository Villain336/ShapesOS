import { listDesignsHandler } from "../_handlers";

export async function GET(req: Request) {
  return listDesignsHandler(req);
}
