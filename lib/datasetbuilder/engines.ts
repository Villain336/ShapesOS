// Marketr — Dataset Builder slice 1: extraction-engine abstraction.
// Spec §1 candidate engine: NeMo Data Designer (Apache-2.0) for synthetic
// augmentation and distillable lineage; frontier APIs for small-batch
// extraction. Slice 1 wires the interface now; the concrete engines land
// later. Tests run against the mock — no keys, no network.

import { DatasetBuilderError } from "./types";

/** What an extraction engine returns for one chunk of document text. */
export interface ExtractionResult {
  /** Candidate entities/facts pulled from the text. */
  entities: ExtractedEntity[];
  /** Which engine produced this, and its version/config fingerprint. */
  lineage: EngineLineage;
}

export interface ExtractedEntity {
  kind: string;
  value: string;
  /** 0–1 confidence; low confidence feeds the slice-2 review queue. */
  confidence: number;
  charStart: number;
  charEnd: number;
}

export interface EngineLineage {
  engine: string;
  engineVersion: string;
  ranAt: string;
}

/** The extraction surface the pipeline (and later slices) depends on. */
export interface ExtractionEngine {
  readonly name: string;
  /**
   * Extract entities/facts from text. Must never invent: entities must be
   * grounded in the input span [charStart, charEnd).
   */
  extract(text: string): Promise<ExtractionResult>;
}

// ----------------------------------------------------- NeMo Data Designer ---

/**
 * NeMo Data Designer (Apache-2.0) stub for later synthetic augmentation
 * and distillable lineage. Constructing it without endpoint config fails
 * closed with ENGINE_NOT_CONFIGURED — slice 1 never requires it live.
 */
export class NemoDataDesignerEngine implements ExtractionEngine {
  readonly name = "nemo-data-designer";
  private readonly endpoint: string | null;

  constructor(endpoint?: string) {
    this.endpoint = endpoint ?? process.env.NEMO_DATA_DESIGNER_ENDPOINT ?? null;
  }

  async extract(_text: string): Promise<ExtractionResult> {
    if (!this.endpoint) {
      throw new DatasetBuilderError(
        "ENGINE_NOT_CONFIGURED",
        "NeMo Data Designer endpoint is not configured (NEMO_DATA_DESIGNER_ENDPOINT)",
      );
    }
    // Slice 2+: POST the synthesis/augmentation job to the endpoint and
    // return entities with lineage { engine: "nemo-data-designer", … }.
    throw new DatasetBuilderError(
      "ENGINE_NOT_CONFIGURED",
      "NeMo Data Designer job execution lands in a later slice",
    );
  }
}

/**
 * Frontier-API small-batch extraction stub. Same fail-closed contract:
 * no key, no call.
 */
export class FrontierExtractionEngine implements ExtractionEngine {
  readonly name = "frontier-api";
  private readonly apiKey: string | null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.EXTRACTION_API_KEY ?? null;
  }

  async extract(_text: string): Promise<ExtractionResult> {
    if (!this.apiKey) {
      throw new DatasetBuilderError(
        "ENGINE_NOT_CONFIGURED",
        "frontier extraction API key is not configured (EXTRACTION_API_KEY)",
      );
    }
    throw new DatasetBuilderError(
      "ENGINE_NOT_CONFIGURED",
      "frontier extraction execution lands in a later slice",
    );
  }
}

// --------------------------------------------------------------- mock ---

/**
 * Deterministic mock: extracts capitalized phrases as entities with
 * fixed confidence, grounded in the exact spans they came from.
 * No network, no keys — this is what tests run against.
 */
export class MockExtractionEngine implements ExtractionEngine {
  readonly name = "mock";
  readonly confidence: number;

  constructor(confidence = 0.9) {
    this.confidence = confidence;
  }

  async extract(text: string): Promise<ExtractionResult> {
    const entities: ExtractedEntity[] = [];
    const re = /\b[A-Z][a-zA-Z0-9&'-]*(?:\s+[A-Z][a-zA-Z0-9&'-]*)*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      entities.push({
        kind: "proper_noun",
        value: m[0],
        confidence: this.confidence,
        charStart: m.index,
        charEnd: m.index + m[0].length,
      });
    }
    return {
      entities,
      lineage: {
        engine: this.name,
        engineVersion: "mock-1",
        ranAt: new Date().toISOString(),
      },
    };
  }
}
