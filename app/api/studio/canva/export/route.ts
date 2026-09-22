import { startExportHandler } from "../_handlers";

export async function POST(req: Request) {
  return startExportHandler(req);
}
