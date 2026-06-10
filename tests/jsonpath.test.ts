import { describe, expect, it } from 'vitest';
import { isSupportedJsonPath, JsonPathError, parseJsonPath } from '../src/comparison/jsonpath';

describe('parseJsonPath — supported subset', () => {
  it('parses a single field', () => {
    expect(parseJsonPath('$.field')).toEqual([{ type: 'key', key: 'field' }]);
  });

  it('parses nested fields', () => {
    expect(parseJsonPath('$.nested.field')).toEqual([
      { type: 'key', key: 'nested' },
      { type: 'key', key: 'field' },
    ]);
  });

  it('parses a wildcard over array elements', () => {
    expect(parseJsonPath('$.items[*].field')).toEqual([
      { type: 'key', key: 'items' },
      { type: 'wildcard' },
      { type: 'key', key: 'field' },
    ]);
  });

  it('parses a wildcard followed by a nested array key', () => {
    expect(parseJsonPath('$.devices[*].permissions')).toEqual([
      { type: 'key', key: 'devices' },
      { type: 'wildcard' },
      { type: 'key', key: 'permissions' },
    ]);
  });

  it('allows dashes and underscores in keys', () => {
    expect(parseJsonPath('$.x-request_id')).toEqual([{ type: 'key', key: 'x-request_id' }]);
  });

  it('allows arbitrarily deep dot chains', () => {
    expect(parseJsonPath('$.a.b.c.d')).toHaveLength(4);
  });

  it('allows multiple wildcards, each between fields', () => {
    expect(parseJsonPath('$.groups[*].users[*].id')).toEqual([
      { type: 'key', key: 'groups' },
      { type: 'wildcard' },
      { type: 'key', key: 'users' },
      { type: 'wildcard' },
      { type: 'key', key: 'id' },
    ]);
  });
});

describe('parseJsonPath — rejections (out of subset)', () => {
  const rejected = [
    'field', // missing root
    '$', // bare root — not one of the supported forms
    '$[*].id', // wildcard at root (must follow a field)
    '$.items[*]', // trailing wildcard (must be followed by a field)
    '$.items[0]', // numeric index
    '$..name', // recursive descent
    "$['field']", // bracket notation
    '$.items[?(@.x)]', // filter
    '$.foo bar', // space
    '$.', // trailing dot
  ];

  for (const path of rejected) {
    it(`rejects ${JSON.stringify(path)}`, () => {
      expect(() => parseJsonPath(path)).toThrow(JsonPathError);
      expect(isSupportedJsonPath(path)).toBe(false);
    });
  }

  it('includes the supported subset in the error message', () => {
    expect(() => parseJsonPath('$.items[0]')).toThrow(/supported subset/);
  });
});
