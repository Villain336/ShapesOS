// ShapesOS — SCIM 2.0 discovery documents (RFC 7644 §4, RFC 7643 §5–7).

import { MAX_PAGE, SCHEMA_GROUP, SCHEMA_RESOURCE_TYPE, SCHEMA_SCHEMA, SCHEMA_SPC, SCHEMA_USER } from "./http";

export function serviceProviderConfig(base: string): Record<string, unknown> {
  return {
    schemas: [SCHEMA_SPC],
    documentationUri: `${base}/dashboard/settings/security`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Per-workspace SCIM token created by an owner in Settings → Security. Send it as `Authorization: Bearer <token>`.",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: `${base}/api/scim/v2/ServiceProviderConfig` },
  };
}

function resourceType(base: string, id: "User" | "Group"): Record<string, unknown> {
  return {
    schemas: [SCHEMA_RESOURCE_TYPE],
    id,
    name: id,
    endpoint: id === "User" ? "/Users" : "/Groups",
    description: id === "User" ? "Workspace member" : "Group mapped to a workspace role (admin, editor or viewer)",
    schema: id === "User" ? SCHEMA_USER : SCHEMA_GROUP,
    meta: { resourceType: "ResourceType", location: `${base}/api/scim/v2/ResourceTypes/${id}` },
  };
}

export function resourceTypes(base: string): Record<string, unknown>[] {
  return [resourceType(base, "User"), resourceType(base, "Group")];
}

type Attr = Record<string, unknown>;
const attr = (name: string, extra: Partial<Attr> = {}): Attr => ({
  name,
  type: "string",
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});

export function schemas(base: string): Record<string, unknown>[] {
  return [
    {
      schemas: [SCHEMA_SCHEMA],
      id: SCHEMA_USER,
      name: "User",
      description: "Workspace member",
      attributes: [
        attr("userName", { required: true, uniqueness: "server", description: "The member's email address." }),
        attr("name", {
          type: "complex",
          subAttributes: [attr("givenName"), attr("familyName"), attr("formatted")],
        }),
        attr("displayName"),
        attr("externalId", { caseExact: true }),
        attr("active", { type: "boolean", description: "false deprovisions the membership (access ends at once)." }),
        attr("emails", {
          type: "complex",
          multiValued: true,
          subAttributes: [attr("value"), attr("type"), attr("primary", { type: "boolean" })],
        }),
        attr("groups", {
          type: "complex",
          multiValued: true,
          mutability: "readOnly",
          subAttributes: [attr("value", { mutability: "readOnly" }), attr("display", { mutability: "readOnly" })],
        }),
      ],
      meta: { resourceType: "Schema", location: `${base}/api/scim/v2/Schemas/${SCHEMA_USER}` },
    },
    {
      schemas: [SCHEMA_SCHEMA],
      id: SCHEMA_GROUP,
      name: "Group",
      description: "Group mapped to a workspace role; the displayName must name admin, editor or viewer.",
      attributes: [
        attr("displayName", { required: true, uniqueness: "server" }),
        attr("externalId", { caseExact: true }),
        attr("members", {
          type: "complex",
          multiValued: true,
          subAttributes: [attr("value", { mutability: "immutable" }), attr("display", { mutability: "readOnly" })],
        }),
      ],
      meta: { resourceType: "Schema", location: `${base}/api/scim/v2/Schemas/${SCHEMA_GROUP}` },
    },
  ];
}
