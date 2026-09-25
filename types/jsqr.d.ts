declare module "jsqr" {
  export interface QrLocation {
    topLeftCorner: { x: number; y: number };
    topRightCorner: { x: number; y: number };
    bottomLeftCorner: { x: number; y: number };
    bottomRightCorner: { x: number; y: number };
  }
  export interface QrResult {
    binaryData: number[];
    data: string;
    chunks: unknown[];
    version: number;
    location: QrLocation;
  }
  export default function jsQR(
    data: Uint8ClampedArray,
    width: number,
    height: number,
  ): QrResult | null;
}
