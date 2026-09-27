import configPromise from "@payload-config";
import { generatePageMetadata, RootPage } from "@payloadcms/next/views";
import { notFound } from "next/navigation";

import { importMap } from "../importMap.js";

type Args = {
  params: Promise<{ segments?: string[] }>;
  searchParams: Promise<{ [key: string]: string | string[] }>;
};

/** Normalizes the optional catch-all into the shape RootPage requires. */
async function toRootParams(params: Args["params"]) {
  const { segments = [] } = await params;
  return { segments };
}

export async function generateMetadata({ params, searchParams }: Args) {
  return generatePageMetadata({
    config: configPromise,
    params: toRootParams(params),
    searchParams,
  });
}

/**
 * Payload admin UI at /admin (Phase 12).
 *
 * Route-level code splitting keeps the heavy admin client out of every other
 * Marketr page's bundle. The `cms-api` guard prevents the catch-all from
 * swallowing the API route namespace.
 */
export default async function AdminPage({ params, searchParams }: Args) {
  const { segments = [] } = await params;
  if (segments[0] === "cms-api") {
    return notFound();
  }
  return (
    <RootPage
      config={configPromise}
      importMap={importMap}
      params={toRootParams(params)}
      searchParams={searchParams}
    />
  );
}
