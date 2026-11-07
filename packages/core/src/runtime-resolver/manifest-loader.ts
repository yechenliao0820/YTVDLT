/**
 * Pure manifest validation (ARCHITECTURE §4.8). No I/O.
 * Failure throws an `UNKNOWN`-coded error — NEVER silently degrades.
 */
import type {
  RuntimeManifest, RuntimeItem, RuntimeKind, RuntimeGroupKind,
} from '@ytvdlt/shared';

export const MANIFEST_SCHEMA_VERSION = 1;

const KINDS: readonly RuntimeKind[] = ['ytdlp', 'node', 'ffmpeg', 'ffprobe', 'aria2c'];
const GROUPS: readonly RuntimeGroupKind[] = ['ytdlp', 'ffmpeg', 'node', 'aria2c'];
const REQUIRED_FIELDS: readonly (keyof RuntimeItem)[] = [
  'path', 'sha256', 'sizeBytes', 'version', 'sourceUrl', 'releaseTag',
  'license', 'required', 'kind', 'group',
];

export class ManifestValidationError extends Error {
  readonly code = 'UNKNOWN' as const;
  constructor(reason: string) {
    super(`runtime-manifest invalid: ${reason}`);
    this.name = 'ManifestValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a parsed manifest object against the §4.8 JSON Schema constraints. */
export function validateManifestObject(value: unknown): RuntimeManifest {
  if (!isRecord(value)) throw new ManifestValidationError('root is not an object');
  if (value['schemaVersion'] !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestValidationError(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (value['platform'] !== 'win-x64') throw new ManifestValidationError('platform must be win-x64');
  if (typeof value['generatedAt'] !== 'string') throw new ManifestValidationError('generatedAt missing');

  const tools = value['toolVersions'];
  if (!isRecord(tools)) throw new ManifestValidationError('toolVersions missing');
  for (const key of ['node', 'npm', 'pnpm']) {
    if (typeof tools[key] !== 'string') throw new ManifestValidationError(`toolVersions.${key} missing`);
  }

  const items = value['items'];
  if (!Array.isArray(items) || items.length < 4) {
    throw new ManifestValidationError('items must be an array with >= 4 entries');
  }

  const validated: RuntimeItem[] = items.map((raw: unknown, index: number) => {
    if (!isRecord(raw)) throw new ManifestValidationError(`items[${index}] is not an object`);
    for (const field of REQUIRED_FIELDS) {
      if (raw[field] === undefined || raw[field] === null) {
        throw new ManifestValidationError(`items[${index}].${field} missing`);
      }
    }
    const allowed = new Set<string>(REQUIRED_FIELDS);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw new ManifestValidationError(`items[${index}] has extra field ${key}`);
    }
    const path = raw['path'];
    if (typeof path !== 'string' || path.length === 0 || path.includes('\\') || path.includes(':')) {
      throw new ManifestValidationError(`items[${index}].path must be POSIX relative`);
    }
    const sha = raw['sha256'];
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
      throw new ManifestValidationError(`items[${index}].sha256 must be lowercase 64-hex`);
    }
    const size = raw['sizeBytes'];
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
      throw new ManifestValidationError(`items[${index}].sizeBytes must be a positive integer`);
    }
    for (const textField of ['version', 'sourceUrl', 'releaseTag', 'license'] as const) {
      if (typeof raw[textField] !== 'string' || (raw[textField] as string).length === 0) {
        throw new ManifestValidationError(`items[${index}].${textField} must be a non-empty string`);
      }
    }
    if (typeof raw['required'] !== 'boolean') {
      throw new ManifestValidationError(`items[${index}].required must be boolean`);
    }
    if (!KINDS.includes(raw['kind'] as RuntimeKind)) {
      throw new ManifestValidationError(`items[${index}].kind invalid`);
    }
    if (!GROUPS.includes(raw['group'] as RuntimeGroupKind)) {
      throw new ManifestValidationError(`items[${index}].group invalid`);
    }
    return {
      path,
      sha256: sha,
      sizeBytes: size,
      version: raw['version'] as string,
      sourceUrl: raw['sourceUrl'] as string,
      releaseTag: raw['releaseTag'] as string,
      license: raw['license'] as string,
      required: raw['required'] as boolean,
      kind: raw['kind'] as RuntimeKind,
      group: raw['group'] as RuntimeGroupKind,
    };
  });

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    platform: 'win-x64',
    generatedAt: value['generatedAt'] as string,
    toolVersions: {
      node: tools['node'] as string,
      npm: tools['npm'] as string,
      pnpm: tools['pnpm'] as string,
    },
    items: validated,
  };
}

/** Parse + validate a manifest JSON string. */
export function validateManifest(jsonText: string): RuntimeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new ManifestValidationError(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateManifestObject(parsed);
}
