// Ambient declaration for the curated @activepieces/piece-* packages.
//
// They ship CommonJS without type declarations. lib/integrations/activepieces/
// pieces.ts loads each one with a literal dynamic import (required for the
// production build) and reads the piece object defensively, so an untyped
// module record is all it needs.
declare module "@activepieces/piece-*" {
  const mod: Record<string, unknown>;
  export = mod;
}
