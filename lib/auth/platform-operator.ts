// ShapesOS — platform operators (Phase 1).
//
// Some resources are host-wide rather than per-tenant: the shared Knowledge
// corpus and the single Activepieces engine. Mutating them is not a
// workspace role — any tenant can be a workspace owner — but an install
// operator. Operators are listed in MARKETR_PLATFORM_OPERATORS as a
// comma-separated list of user emails and/or user ids. Unset → nobody is an
// operator (fail closed); a self-hoster adds their own email.

export function platformOperatorList(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MARKETR_PLATFORM_OPERATORS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformOperator(
  user: { id: string; email?: string | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!user?.id) return false;
  const ops = platformOperatorList(env);
  if (ops.length === 0) return false;
  const email = (user.email ?? "").trim().toLowerCase();
  return ops.includes(user.id.toLowerCase()) || (email !== "" && ops.includes(email));
}
