/**
 * Tool argument descriptors: one declaration, two consumers.
 *
 * A tool's `inputSchema` tells the model what to send; runtime validation
 * decides what actually reaches the dispatcher. Written separately they drift,
 * and the drift is invisible — the schema keeps promising a constraint nobody
 * enforces. Here both are derived from the same `ParamSpec`, so a tool cannot
 * advertise one contract and accept another.
 *
 * Deliberately not a JSON Schema engine. Tool arguments on this surface are
 * flat — strings, numbers, booleans, and string arrays — and a general
 * validator would be a large dependency-shaped thing to maintain for a shape
 * this narrow. Anything needing more expressiveness than this is a sign the
 * tool should be split, not that the descriptor should grow.
 */
import { CraftdriverError, ErrorCode } from '../../lib/errors.js';

/** Cap on any single string argument, unless a spec narrows it further. */
export const DEFAULT_MAX_STRING = 8192;
/** Cap on any array argument, unless a spec narrows it further. */
export const DEFAULT_MAX_ITEMS = 50;

interface Common {
  description?: string;
  required?: boolean;
}

export type ParamSpec =
  | (Common & {
      type: 'string';
      maxLength?: number;
      /** Allowed values. Anything else is rejected, listing the valid set. */
      enum?: readonly string[];
    })
  | (Common & {
      type: 'number';
      min?: number;
      max?: number;
      integer?: boolean;
    })
  | (Common & { type: 'boolean' })
  | (Common & {
      type: 'string[]';
      maxItems?: number;
      maxLength?: number;
    });

export type ParamSpecs = Record<string, ParamSpec>;

/** JSON Schema for `tools/list`, derived from the same specs validation uses. */
export function toInputSchema(specs: ParamSpecs): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, spec] of Object.entries(specs)) {
    if (spec.required) required.push(name);
    const base: Record<string, unknown> = {};
    if (spec.description) base.description = spec.description;

    switch (spec.type) {
      case 'string':
        properties[name] = {
          type: 'string',
          ...base,
          maxLength: spec.maxLength ?? DEFAULT_MAX_STRING,
          ...(spec.enum ? { enum: [...spec.enum] } : {}),
        };
        break;
      case 'number':
        properties[name] = {
          type: spec.integer ? 'integer' : 'number',
          ...base,
          ...(spec.min !== undefined ? { minimum: spec.min } : {}),
          ...(spec.max !== undefined ? { maximum: spec.max } : {}),
        };
        break;
      case 'boolean':
        properties[name] = { type: 'boolean', ...base };
        break;
      case 'string[]':
        properties[name] = {
          type: 'array',
          ...base,
          items: { type: 'string', maxLength: spec.maxLength ?? DEFAULT_MAX_STRING },
          maxItems: spec.maxItems ?? DEFAULT_MAX_ITEMS,
        };
        break;
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    // Advertised as well as enforced: a model that sends an extra field should
    // be able to learn from the schema that it will be refused.
    additionalProperties: false,
  };
}

function invalid(tool: string, message: string, detail?: Record<string, unknown>): CraftdriverError {
  return new CraftdriverError(ErrorCode.INVALID_ARGUMENT, `${tool}: ${message}`, {
    ...(detail ? { detail } : {}),
  });
}

/**
 * Validate and normalize tool arguments.
 *
 * Throws `INVALID_ARGUMENT` — which the server maps to JSON-RPC `-32602` —
 * before anything reaches the dispatcher. Returns only declared keys, so a
 * field that slipped past cannot ride along into a browser command.
 */
export function validateArgs(
  tool: string,
  specs: ParamSpecs,
  raw: unknown,
): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid(tool, 'arguments must be an object');
  }
  const args = raw as Record<string, unknown>;

  // Unknown fields are refused rather than ignored: silently dropping one
  // means a model that misspelled a required argument sees a successful call
  // that did something other than what it asked for.
  const known = new Set(Object.keys(specs));
  const unknown = Object.keys(args).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw invalid(tool, `unknown argument "${unknown[0]}"`, {
      unknown,
      allowed: [...known],
    });
  }

  const out: Record<string, unknown> = {};

  for (const [name, spec] of Object.entries(specs)) {
    const value = args[name];

    if (value === undefined || value === null) {
      if (spec.required) throw invalid(tool, `missing required argument "${name}"`);
      continue;
    }

    switch (spec.type) {
      case 'string': {
        if (typeof value !== 'string') {
          throw invalid(tool, `"${name}" must be a string, got ${typeof value}`);
        }
        const max = spec.maxLength ?? DEFAULT_MAX_STRING;
        if (value.length > max) {
          throw invalid(tool, `"${name}" is too long (${value.length} chars; max ${max})`);
        }
        if (spec.enum && !spec.enum.includes(value)) {
          throw invalid(tool, `"${name}" must be one of: ${spec.enum.join(', ')}`, {
            allowed: [...spec.enum],
          });
        }
        out[name] = value;
        break;
      }

      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          // NaN and Infinity are `typeof number` but serialize to null and
          // break every downstream range check, so they are rejected here.
          throw invalid(tool, `"${name}" must be a finite number`);
        }
        if (spec.integer && !Number.isInteger(value)) {
          throw invalid(tool, `"${name}" must be an integer`);
        }
        if (spec.min !== undefined && value < spec.min) {
          throw invalid(tool, `"${name}" must be >= ${spec.min}`);
        }
        if (spec.max !== undefined && value > spec.max) {
          throw invalid(tool, `"${name}" must be <= ${spec.max}`);
        }
        out[name] = value;
        break;
      }

      case 'boolean': {
        if (typeof value !== 'boolean') {
          throw invalid(tool, `"${name}" must be a boolean, got ${typeof value}`);
        }
        out[name] = value;
        break;
      }

      case 'string[]': {
        if (!Array.isArray(value)) {
          throw invalid(tool, `"${name}" must be an array of strings`);
        }
        const maxItems = spec.maxItems ?? DEFAULT_MAX_ITEMS;
        if (value.length > maxItems) {
          throw invalid(tool, `"${name}" has too many items (${value.length}; max ${maxItems})`);
        }
        const maxLength = spec.maxLength ?? DEFAULT_MAX_STRING;
        value.forEach((item, index) => {
          if (typeof item !== 'string') {
            throw invalid(tool, `"${name}[${index}]" must be a string, got ${typeof item}`);
          }
          if (item.length > maxLength) {
            throw invalid(
              tool,
              `"${name}[${index}]" is too long (${item.length} chars; max ${maxLength})`,
            );
          }
        });
        out[name] = [...value];
        break;
      }
    }
  }

  return out;
}
