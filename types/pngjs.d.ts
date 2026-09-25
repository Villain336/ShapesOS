declare module "pngjs" {
  export interface PNGOptions {
    width: number;
    height: number;
    filterType?: number;
    colorType?: number;
    inputColorType?: number;
    inputHasAlpha?: boolean;
    bgColor?: { red: number; green: number; blue: number };
  }
  export class PNG {
    constructor(options: PNGOptions);
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      read(buffer: Buffer | Uint8Array): PNG;
      write(png: PNG, options?: Record<string, unknown>): Buffer;
    };
    pack(): NodeJS.ReadableStream;
    parse(data: Buffer | Uint8Array, callback?: (error: Error | null, data: PNG) => void): void;
    on(event: string, callback: (...args: unknown[]) => void): this;
  }
}
