import { autofillHandler } from "../_handlers";

export async function POST(req: Request) {
  return autofillHandler(req);
}
