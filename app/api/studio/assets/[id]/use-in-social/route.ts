import { useInSocialHandler } from "../../_handlers";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return useInSocialHandler(req, id);
}
