import { pollExportHandler } from "../../_handlers";

export async function GET(req: Request, ctx: { params: Promise<{ exportId: string }> }) {
  const { exportId } = await ctx.params;
  return pollExportHandler(req, exportId);
}
