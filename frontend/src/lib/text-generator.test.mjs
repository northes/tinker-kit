import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./text-generator.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
const { generateText, linePool, parseSeparator, quoteValue, secureRandomIndex } = await import(
  moduleUrl
);

assert.equal(parseSeparator(',\\n'), ',\n');
assert.equal(parseSeparator('\\t\\\\'), '\t\\');
assert.equal(quoteValue(`a'b\\c`, 'single'), `'a\\'b\\\\c'`);
assert.equal(quoteValue('a"b\\c', 'double'), '"a\\"b\\\\c"');
assert.deepEqual(linePool(' one\r\n\r\n  \n two '), [' one', ' two ']);
assert.equal(
  secureRandomIndex(3, (value) => ((value[0] = 5), value)),
  2,
);
assert.equal(
  generateText({
    kind: 'character',
    pool: ['a'],
    length: 4,
    quantity: 2,
    separator: ',\\n',
    quote: 'double',
  }),
  '"aaaa",\n"aaaa"',
);
assert.equal(
  generateText({
    kind: 'line',
    pool: ['word'],
    length: 3,
    quantity: 1,
    separator: '',
    quote: 'none',
  }),
  'wordwordword',
);
assert.equal(
  generateText({
    kind: 'uuid',
    length: 512,
    quantity: 2,
    separator: '|',
    quote: 'none',
    uuid: () => 'uuid',
  }),
  'uuid|uuid',
);

console.log('text-generator tests passed');
