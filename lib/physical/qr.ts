// Marketr — Physical attribution kit (P2): QR code generation.
//
// QR content is always the bundle's vanity URL. Regeneration is a style
// change (color / margin / error-correction presets), not a content change —
// the printed code keeps working because the URL never changes.

import QRCode from "qrcode";

export const QR_STYLES = [
  { dark: "#171321", light: "#ffffff", margin: 2, errorCorrectionLevel: "M" as const },
  { dark: "#4c1d95", light: "#ffffff", margin: 3, errorCorrectionLevel: "Q" as const },
  { dark: "#0f172a", light: "#f8fafc", margin: 1, errorCorrectionLevel: "H" as const },
] as const;

export function qrStyleIndex(n: number): number {
  return ((n % QR_STYLES.length) + QR_STYLES.length) % QR_STYLES.length;
}

export async function qrPngDataUrl(url: string, styleIdx = 0): Promise<string> {
  const s = QR_STYLES[qrStyleIndex(styleIdx)];
  return QRCode.toDataURL(url, {
    width: 512,
    margin: s.margin,
    color: { dark: s.dark, light: s.light },
    errorCorrectionLevel: s.errorCorrectionLevel,
  });
}

export async function qrSvgString(url: string, styleIdx = 0): Promise<string> {
  const s = QR_STYLES[qrStyleIndex(styleIdx)];
  return QRCode.toString(url, {
    type: "svg",
    width: 512,
    margin: s.margin,
    color: { dark: s.dark, light: s.light },
    errorCorrectionLevel: s.errorCorrectionLevel,
  });
}
