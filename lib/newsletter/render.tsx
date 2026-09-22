// Marketr — newsletter renderer (milestone 19).
//
// Tiptap JSON email blocks → react-email component tree → HTML string.
// Server-side only (used by the preview route, test sends, and broadcasts).
// The renderer ALWAYS runs ensureUnsubscribe() first: no template can go out
// without an unsubscribe link, regardless of what the UI did.

import * as React from "react";
import { render } from "react-email";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import {
  attr,
  DEFAULT_BRAND,
  ensureUnsubscribe,
  textLines,
  type EmailBlockNode,
  type EmailTiptapDoc,
  type InlineRun,
  type NewsletterBrand,
} from "./blocks";

export interface RenderOptions {
  brand?: NewsletterBrand;
  /** Absolute app URL (for the unsubscribe link + relative asset URLs). */
  baseUrl: string;
  /** Per-recipient unsubscribe token — the link is injected per send. */
  unsubscribeToken?: string;
  previewText?: string;
}

function absoluteUrl(url: string, baseUrl: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
}

/**
 * Day-1 fix (edge #5): link href allow-list. Only http(s) and site-relative
 * URLs are emitted; anything else (javascript:, data:, vbscript:, and
 * whitespace/control-char obfuscations of them) renders as inert "#".
 * Templates are operator-editable, so this is a stored-XSS boundary.
 */
function safeHref(raw: string | undefined | null): string {
  if (!raw) return "#";
  // Strip whitespace/control chars first — defeats "java\tscript:" tricks.
  const cleaned = raw.replace(/[\u0000-\u0020\u007f-\u00a0]+/g, "").trim();
  if (!cleaned) return "#";
  const scheme = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme && scheme[1].toLowerCase() !== "http" && scheme[1].toLowerCase() !== "https") {
    return "#";
  }
  return cleaned;
}

function RunSpan({ run, color }: { run: InlineRun; color: string }) {
  const style: React.CSSProperties = {
    color,
    fontWeight: run.bold ? 700 : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecoration: [run.underline ? "underline" : "", run.strike ? "line-through" : ""]
      .filter(Boolean)
      .join(" ") || undefined,
  };
  if (run.href) {
    return (
      <Link href={safeHref(run.href)} style={{ ...style, color: "#4f46e5", textDecoration: "underline" }}>
        {run.text}
      </Link>
    );
  }
  return <span style={style}>{run.text}</span>;
}

function TextBlock({ node, brand }: { node: EmailBlockNode; brand: NewsletterBrand }) {
  const lines = textLines(node);
  return (
    <Section style={{ padding: "12px 32px" }}>
      {lines.map((line, i) =>
        line.kind === "heading" ? (
          <Heading
            key={i}
            as="h2"
            style={{
              fontFamily: brand.fonts.heading,
              fontSize: "22px",
              lineHeight: "30px",
              color: brand.colors.text,
              margin: "12px 0",
            }}
          >
            {line.runs.map((run, j) => (
              <RunSpan key={j} run={run} color={brand.colors.text} />
            ))}
          </Heading>
        ) : (
          <Text
            key={i}
            style={{
              fontFamily: brand.fonts.body,
              fontSize: "15px",
              lineHeight: "24px",
              color: brand.colors.text,
              margin: "8px 0",
            }}
          >
            {line.runs.map((run, j) => (
              <RunSpan key={j} run={run} color={brand.colors.text} />
            ))}
          </Text>
        ),
      )}
    </Section>
  );
}

function Block({
  node,
  brand,
  baseUrl,
}: {
  node: EmailBlockNode;
  brand: NewsletterBrand;
  baseUrl: string;
}) {
  switch (node.type) {
    case "emailHeader": {
      const logoUrl = attr(node, "logoUrl") || brand.logoUrl || "";
      const tagline = attr(node, "tagline");
      return (
        <Section style={{ padding: "24px 32px 8px", textAlign: "center" }}>
          {logoUrl ? (
            <Img
              src={absoluteUrl(logoUrl, baseUrl)}
              alt={brand.companyName ?? "Logo"}
              width="120"
              style={{ margin: "0 auto" }}
            />
          ) : null}
          {tagline ? (
            <Text
              style={{
                fontFamily: brand.fonts.body,
                fontSize: "13px",
                color: brand.colors.muted,
                margin: "8px 0 0",
              }}
            >
              {tagline}
            </Text>
          ) : null}
        </Section>
      );
    }
    case "emailHero": {
      const imageUrl = attr(node, "imageUrl");
      return (
        <Section style={{ padding: "16px 32px", textAlign: "center" }}>
          {imageUrl ? (
            <Img
              src={absoluteUrl(imageUrl, baseUrl)}
              alt={attr(node, "title")}
              width="536"
              style={{ borderRadius: "8px", margin: "0 auto 16px", maxWidth: "100%" }}
            />
          ) : null}
          <Heading
            as="h1"
            style={{
              fontFamily: brand.fonts.heading,
              fontSize: "30px",
              lineHeight: "38px",
              color: brand.colors.text,
              margin: "0 0 8px",
            }}
          >
            {attr(node, "title")}
          </Heading>
          {attr(node, "subtitle") ? (
            <Text
              style={{
                fontFamily: brand.fonts.body,
                fontSize: "16px",
                lineHeight: "26px",
                color: brand.colors.secondary,
                margin: "0",
              }}
            >
              {attr(node, "subtitle")}
            </Text>
          ) : null}
        </Section>
      );
    }
    case "emailText":
      return <TextBlock node={node} brand={brand} />;
    case "emailImage": {
      const src = attr(node, "src");
      if (!src) return null;
      return (
        <Section style={{ padding: "12px 32px", textAlign: "center" }}>
          <Img
            src={absoluteUrl(src, baseUrl)}
            alt={attr(node, "alt")}
            width="536"
            style={{ borderRadius: "8px", margin: "0 auto", maxWidth: "100%" }}
          />
          {attr(node, "caption") ? (
            <Text
              style={{
                fontFamily: brand.fonts.body,
                fontSize: "12px",
                color: brand.colors.muted,
                margin: "8px 0 0",
              }}
            >
              {attr(node, "caption")}
            </Text>
          ) : null}
        </Section>
      );
    }
    case "emailButton":
      return (
        <Section style={{ padding: "16px 32px", textAlign: "center" }}>
          <Button
            href={safeHref(attr(node, "href"))}
            style={{
              backgroundColor: brand.colors.accent,
              color: "#ffffff",
              fontFamily: brand.fonts.body,
              fontSize: "15px",
              fontWeight: 600,
              padding: "12px 28px",
              borderRadius: "8px",
              textDecoration: "none",
              display: "inline-block",
            }}
          >
            {attr(node, "label", "Read more")}
          </Button>
        </Section>
      );
    case "emailDivider":
      return (
        <Section style={{ padding: "8px 32px" }}>
          <Hr style={{ borderColor: "#e5e7eb", margin: "8px 0" }} />
        </Section>
      );
    case "emailFooter": {
      const unsubUrl = attr(node, "unsubUrl");
      const companyName = attr(node, "companyName") || brand.companyName || "";
      const address = attr(node, "address");
      return (
        <Section style={{ padding: "24px 32px", textAlign: "center" }}>
          <Hr style={{ borderColor: "#e5e7eb", margin: "0 0 16px" }} />
          {companyName ? (
            <Text
              style={{
                fontFamily: brand.fonts.body,
                fontSize: "13px",
                fontWeight: 600,
                color: brand.colors.secondary,
                margin: "0 0 4px",
              }}
            >
              {companyName}
            </Text>
          ) : null}
          {address ? (
            <Text
              style={{ fontFamily: brand.fonts.body, fontSize: "12px", color: brand.colors.muted, margin: "0 0 8px" }}
            >
              {address}
            </Text>
          ) : null}
          {unsubUrl ? (
            <Text style={{ fontFamily: brand.fonts.body, fontSize: "12px", color: brand.colors.muted, margin: "8px 0 0" }}>
              <Link href={unsubUrl} style={{ color: brand.colors.muted, textDecoration: "underline" }}>
                Unsubscribe
              </Link>
            </Text>
          ) : null}
        </Section>
      );
    }
  }
}

function NewsletterEmail({
  doc,
  brand,
  baseUrl,
  previewText,
}: {
  doc: EmailTiptapDoc;
  brand: NewsletterBrand;
  baseUrl: string;
  previewText?: string;
}) {
  return (
    <Html>
      <Head />
      {previewText ? <Preview>{previewText}</Preview> : null}
      <Body style={{ backgroundColor: "#f3f4f6", margin: "0", padding: "24px 0" }}>
        <Container
          style={{
            backgroundColor: "#ffffff",
            borderRadius: "12px",
            margin: "0 auto",
            maxWidth: "600px",
            overflow: "hidden",
          }}
        >
          {doc.content.map((node, i) => (
            <Block key={i} node={node} brand={brand} baseUrl={baseUrl} />
          ))}
        </Container>
      </Body>
    </Html>
  );
}

/**
 * Render a newsletter Tiptap doc to a final HTML email string.
 * Enforces the unsubscribe link at render time (per-recipient when a token
 * is provided; the plain base URL form otherwise).
 */
export async function renderNewsletter(doc: EmailTiptapDoc, opts: RenderOptions): Promise<string> {
  const brand = opts.brand ?? DEFAULT_BRAND;
  const unsubscribeUrl = opts.unsubscribeToken
    ? `${opts.baseUrl.replace(/\/$/, "")}/api/newsletter/unsubscribe?token=${encodeURIComponent(opts.unsubscribeToken)}`
    : `${opts.baseUrl.replace(/\/$/, "")}/unsubscribe`;
  const safe = ensureUnsubscribe(doc, unsubscribeUrl);
  return render(
    <NewsletterEmail doc={safe} brand={brand} baseUrl={opts.baseUrl} previewText={opts.previewText} />,
  );
}
