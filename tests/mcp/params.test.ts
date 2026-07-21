/**
 * Tool argument descriptors: schema and validator derived from one spec.
 *
 * The acceptance criterion is "invalid arguments cannot reach the dispatcher",
 * and before this there was no validation at all — wire arguments went
 * straight into `toDispatch`. These are table-driven on purpose: the failure
 * mode worth guarding is a *category* of bad input slipping through, not one
 * example of it.
 */
import { describe, it, expect } from 'vitest';
import { CraftdriverError, ErrorCode } from '../../src/lib/errors.js';
import {
  toInputSchema,
  validateArgs,
  DEFAULT_MAX_STRING,
  DEFAULT_MAX_ITEMS,
  type ParamSpecs,
} from '../../src/cli/mcp/params.js';

const specs: ParamSpecs = {
  selector: { type: 'string', required: true, description: 'CSS or prefixed' },
  value: { type: 'string' },
  count: { type: 'number', min: 1, max: 10, integer: true },
  ratio: { type: 'number' },
  flag: { type: 'boolean' },
  mode: { type: 'string', enum: ['visible', 'hidden'] },
  files: { type: 'string[]', maxItems: 3 },
};

function reject(args: unknown): CraftdriverError {
  try {
    validateArgs('tool', specs, args);
  } catch (err) {
    return err as CraftdriverError;
  }
  throw new Error('expected validateArgs to reject');
}

describe('schema derived from the spec', () => {
  const schema = toInputSchema(specs) as {
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, Record<string, unknown>>;
  };

  it('marks only required params required', () => {
    expect(schema.required).toEqual(['selector']);
  });

  it('refuses extra properties in the advertised contract too', () => {
    // Enforced at runtime; advertising it lets a model learn the rule.
    expect(schema.additionalProperties).toBe(false);
  });

  it('carries bounds into the schema so they are not invisible promises', () => {
    expect(schema.properties.selector).toMatchObject({
      type: 'string',
      maxLength: DEFAULT_MAX_STRING,
    });
    expect(schema.properties.count).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 10,
    });
    expect(schema.properties.mode).toMatchObject({ enum: ['visible', 'hidden'] });
    expect(schema.properties.files).toMatchObject({ type: 'array', maxItems: 3 });
  });

  it('omits required entirely when nothing is required', () => {
    expect(toInputSchema({ a: { type: 'string' } })).not.toHaveProperty('required');
  });
});

describe('accepting valid arguments', () => {
  it('returns the declared values', () => {
    expect(
      validateArgs('tool', specs, {
        selector: '#a',
        count: 3,
        flag: true,
        mode: 'visible',
        files: ['a', 'b'],
      }),
    ).toEqual({ selector: '#a', count: 3, flag: true, mode: 'visible', files: ['a', 'b'] });
  });

  it('treats absent optionals as absent, not as undefined keys', () => {
    const out = validateArgs('tool', specs, { selector: '#a' });
    expect(out).toEqual({ selector: '#a' });
    expect('value' in out).toBe(false);
  });

  it('accepts a missing arguments object when nothing is required', () => {
    expect(validateArgs('tool', { a: { type: 'string' } }, undefined)).toEqual({});
  });

  it('accepts null the same as absent for an optional', () => {
    expect(validateArgs('tool', specs, { selector: '#a', value: null })).toEqual({
      selector: '#a',
    });
  });
});

describe('rejecting invalid arguments', () => {
  it.each([
    ['a non-object', 'nope', /must be an object/],
    ['an array', ['a'], /must be an object/],
    ['a missing required field', {}, /missing required argument "selector"/],
    ['an explicitly null required field', { selector: null }, /missing required argument/],
    ['an unknown field', { selector: '#a', bogus: 1 }, /unknown argument "bogus"/],
    ['a wrong-typed string', { selector: 42 }, /"selector" must be a string/],
    ['a wrong-typed boolean', { selector: '#a', flag: 'yes' }, /"flag" must be a boolean/],
    ['a wrong-typed number', { selector: '#a', count: '3' }, /must be a finite number/],
    ['NaN', { selector: '#a', ratio: Number.NaN }, /must be a finite number/],
    ['Infinity', { selector: '#a', ratio: Number.POSITIVE_INFINITY }, /must be a finite number/],
    ['a non-integer', { selector: '#a', count: 1.5 }, /must be an integer/],
    ['a number below range', { selector: '#a', count: 0 }, /must be >= 1/],
    ['a number above range', { selector: '#a', count: 99 }, /must be <= 10/],
    ['an invalid enum', { selector: '#a', mode: 'sideways' }, /must be one of: visible, hidden/],
    ['a non-array for an array field', { selector: '#a', files: 'a' }, /must be an array/],
    ['a non-string array item', { selector: '#a', files: [1] }, /"files\[0\]" must be a string/],
    ['too many items', { selector: '#a', files: ['a', 'b', 'c', 'd'] }, /too many items/],
  ])('rejects %s', (_label, args, pattern) => {
    const err = reject(args);
    expect(err.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(err.message).toMatch(pattern);
  });

  it('rejects an oversized string', () => {
    const err = reject({ selector: 'x'.repeat(DEFAULT_MAX_STRING + 1) });
    expect(err.message).toMatch(/too long/);
  });

  it('rejects an oversized array item', () => {
    const err = reject({ selector: '#a', files: ['x'.repeat(DEFAULT_MAX_STRING + 1)] });
    expect(err.message).toMatch(/"files\[0\]" is too long/);
  });

  it('names the tool, so an agent can tell which call failed', () => {
    expect(reject({}).message).toMatch(/^tool: /);
  });

  it('lists the allowed fields when one is unknown', () => {
    expect(reject({ selector: '#a', slector: 1 }).detail).toMatchObject({
      unknown: ['slector'],
    });
  });
});

describe('defaults are real bounds, not decoration', () => {
  it('caps an undeclared array length', () => {
    const loose: ParamSpecs = { items: { type: 'string[]' } };
    expect(() =>
      validateArgs('tool', loose, { items: new Array(DEFAULT_MAX_ITEMS + 1).fill('x') }),
    ).toThrow(/too many items/);
  });

  it('drops undeclared keys from the returned object', () => {
    // Even if the unknown-field check were bypassed, nothing undeclared can
    // ride along into a browser command.
    const out = validateArgs('tool', { a: { type: 'string' } }, { a: 'x' });
    expect(Object.keys(out)).toEqual(['a']);
  });
});
