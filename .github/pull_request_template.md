# Marketr pull request

## What / why

<!-- One-paragraph summary. Link the spec (SPEC-*.md) or issue. -->

## Verification (required — paste outputs)

- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` green
- [ ] Module battery: `npx tsx scripts/verify-<module>.mts` — output pasted below
- [ ] Security battery (`node scripts/verify-m11-security.mjs`) if a security surface changed

<details>
<summary>Battery output</summary>

```
# paste here
```

</details>

## Checklist

- [ ] One concern per PR; diff is reviewable
- [ ] Follows module conventions (`lib/`, `app/api/`, `app/dashboard/`, prisma fragments)
- [ ] **No secrets, credentials, or real PII** in code, fixtures, or seeds
- [ ] New module ships with its own `scripts/verify-*.mts` battery
- [ ] UI uses Lucide icons only (no emoji UI)
- [ ] Money-safety: no autopilot spend introduced (or explicitly approved in the spec)

## Open-vs-commercial

<!-- Which side of the CONTRIBUTING.md boundary does this fall on? If commercial-layer
     (white-label removal, SSO/RBAC gating, license enforcement), it needs a spec + the
     split decision — flag it here. -->
