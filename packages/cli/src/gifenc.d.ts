declare module "gifenc" {
  interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: number[][];
        delay?: number;
        dispose?: number;
        transparent?: boolean;
        transparentIndex?: number;
        repeat?: number;
        colorDepth?: number;
        first?: boolean;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
    readonly stream: unknown;
  }

  export function GIFEncoder(): GIFEncoderInstance;

  export function quantize(
    data: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: "rgb565" | "rgb444" | "rgba4444" },
  ): number[][];

  export function applyPalette(
    data: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: "rgb565" | "rgb444" | "rgba4444",
  ): Uint8Array;

  export function snapColorsToPalette(
    palette: number[][],
    knownColors: number[][],
    threshold?: number,
  ): void;

  export function prequantize(
    data: Uint8Array | Uint8ClampedArray,
    opts?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number },
  ): void;
}
