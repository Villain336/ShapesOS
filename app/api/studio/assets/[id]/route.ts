import { deleteAssetHandler } from "../_handlers";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return deleteAssetHandler(req, id);
}
