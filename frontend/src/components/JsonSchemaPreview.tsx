import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  CaretDown,
  CaretRight,
  CaretUp,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';

export type JsonSchemaObject = Record<string, unknown>;
type JsonSchemaValue = boolean | JsonSchemaObject;
type SchemaChildKind = 'property' | 'index' | 'definition' | 'composition' | 'keyword';
type SchemaChild = {
  label: string;
  path: string;
  schema: JsonSchemaValue;
  required?: boolean;
  kind: SchemaChildKind;
};
type SchemaDocument = {
  root: JsonSchemaValue;
  key: string;
  baseUrl?: string;
};
type ExternalReference = {
  key: string;
  requestUrl: string;
  fragment: string;
  source: string;
};
type ExternalRefState =
  | { status: 'loading' }
  | { status: 'loaded'; schema: JsonSchemaValue; document: SchemaDocument }
  | { status: 'error' };
type SchemaMeta = { keyword: string; value?: string; full?: string };
type SchemaMatches = {
  count: number;
  starts: Map<string, number>;
  pathsById: string[];
};
type TreeCommand = { id: number; expanded: boolean };
type ExpandTarget = { id: number; path: string };
type Translate = ReturnType<typeof useTranslation>['t'];

const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);
const JSON_SCHEMA_STRUCTURAL_KEYS = new Set([
  '$defs',
  '$ref',
  'additionalProperties',
  'allOf',
  'anyOf',
  'contains',
  'dependentRequired',
  'dependentSchemas',
  'definitions',
  'else',
  'if',
  'items',
  'not',
  'oneOf',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'required',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const JSON_SCHEMA_CONSTRAINT_KEYS = new Set([
  'const',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'maximum',
  'maxItems',
  'maxLength',
  'maxProperties',
  'minimum',
  'minItems',
  'minLength',
  'minProperties',
  'multipleOf',
  'pattern',
  'uniqueItems',
]);
const JSON_SCHEMA_METADATA_KEYS = new Set([
  '$comment',
  '$id',
  '$schema',
  'default',
  'description',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
]);
const JSON_SCHEMA_KEYS = new Set([
  ...JSON_SCHEMA_STRUCTURAL_KEYS,
  ...JSON_SCHEMA_CONSTRAINT_KEYS,
  ...JSON_SCHEMA_METADATA_KEYS,
  'type',
]);

const DEFINITION_KEYWORDS = ['$defs', 'definitions', 'dependentSchemas'] as const;
const COMPOSITION_KEYWORDS = ['allOf', 'anyOf', 'oneOf'] as const;
const KEYWORD_CHILD_KEYS = [
  'contains',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
] as const;
const META_ORDER = [
  '$ref',
  'enum',
  'const',
  'format',
  'pattern',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'readOnly',
  'writeOnly',
  'deprecated',
] as const;

const EMPTY_REF_STACK: string[] = [];

function isObject(value: unknown): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchemaValue(value: unknown): value is JsonSchemaValue {
  return typeof value === 'boolean' || isObject(value);
}

function isSchemaType(value: unknown): boolean {
  return (
    (typeof value === 'string' && JSON_SCHEMA_TYPES.has(value)) ||
    (Array.isArray(value) && value.length > 0 && value.every((item) => isSchemaType(item)))
  );
}

/**
 * JSON Schema does not require the optional `$schema` marker. Prefer the
 * marker when present, then fall back to the structural keywords that make a
 * JSON document unambiguously schema-shaped.
 */
export function isJsonSchema(value: unknown): value is JsonSchemaObject {
  if (!isObject(value)) return false;

  const keys = Object.keys(value);
  const hasSchemaMarker = ['$schema', '$id', '$ref'].some((key) => key in value);
  const hasStructuralShape = keys.some((key) => JSON_SCHEMA_STRUCTURAL_KEYS.has(key));
  const hasConstraintShape = keys.some((key) => JSON_SCHEMA_CONSTRAINT_KEYS.has(key));
  const hasValidType = isSchemaType(value.type);

  if (hasSchemaMarker || hasStructuralShape || hasConstraintShape) return true;
  return hasValidType && keys.every((key) => JSON_SCHEMA_KEYS.has(key));
}

function pointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function resolveJsonPointer(root: JsonSchemaValue, ref: string): JsonSchemaValue | null {
  if (!ref.startsWith('#')) return null;
  if (ref === '#') return root;

  let pointer = ref.slice(1);
  try {
    pointer = decodeURIComponent(pointer);
  } catch {
    return null;
  }
  if (!pointer.startsWith('/')) return null;

  if (!isObject(root)) return null;
  let current: unknown = root;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return null;
      current = current[Number(segment)];
    } else if (isObject(current) && segment in current) {
      current = current[segment];
    } else {
      return null;
    }
    if (current === undefined) return null;
  }

  return isSchemaValue(current) ? current : null;
}

function schemaBaseUrl(root: JsonSchemaValue, fallback?: string): string | undefined {
  const id = typeof root === 'object' && typeof root.$id === 'string' ? root.$id : fallback;
  if (!id) return undefined;
  try {
    const url = new URL(id, fallback);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function createExternalReference(ref: string, baseUrl?: string): ExternalReference | null {
  try {
    const url = new URL(ref, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const fragment = url.hash || '#';
    const key = url.href;
    url.hash = '';
    return { key, requestUrl: url.href, fragment, source: ref };
  } catch {
    return null;
  }
}

async function fetchExternalReference(
  reference: ExternalReference,
  signal: AbortSignal,
): Promise<{ schema: JsonSchemaValue; document: SchemaDocument }> {
  const response = await fetch(reference.requestUrl, {
    headers: { Accept: 'application/schema+json, application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const root: unknown = await response.json();
  if (!isSchemaValue(root)) throw new Error('invalidSchema');

  const document: SchemaDocument = {
    root,
    key: reference.requestUrl,
    baseUrl: schemaBaseUrl(root, response.url || reference.requestUrl),
  };
  const schema = resolveJsonPointer(root, reference.fragment);
  if (schema === null) throw new Error('refNotFound');
  return { schema, document };
}

function resolveSchemaValue(
  schema: JsonSchemaValue,
  document: SchemaDocument,
  refStack: string[],
  externalRefs: ReadonlyMap<string, ExternalRefState>,
): {
  schema: JsonSchemaValue;
  document: SchemaDocument;
  refStack: string[];
  external?: { reference: ExternalReference; state?: ExternalRefState };
} {
  let resolved = schema;
  let resolvedDocument = document;
  let nextRefStack = refStack;
  let external: { reference: ExternalReference; state?: ExternalRefState } | undefined;

  while (isObject(resolved) && typeof resolved.$ref === 'string') {
    const ref = resolved.$ref;
    if (ref.startsWith('#')) {
      const refKey = `${resolvedDocument.key}:${ref}`;
      if (nextRefStack.includes(refKey)) break;
      const target = resolveJsonPointer(resolvedDocument.root, ref);
      if (target === null) break;
      nextRefStack = [...nextRefStack, refKey];
      resolved = target;
      continue;
    }

    const reference = createExternalReference(ref, resolvedDocument.baseUrl);
    if (!reference) break;
    const state = externalRefs.get(reference.key);
    if (!state || state.status !== 'loaded') {
      external = { reference, state };
      break;
    }
    if (nextRefStack.includes(reference.key)) break;
    nextRefStack = [...nextRefStack, reference.key];
    resolved = state.schema;
    resolvedDocument = state.document;
  }

  return { schema: resolved, document: resolvedDocument, refStack: nextRefStack, external };
}

function mergeResolvedSchema(
  original: JsonSchemaValue,
  resolved: JsonSchemaValue,
): JsonSchemaValue {
  if (original === resolved || typeof original === 'boolean' || typeof resolved === 'boolean')
    return resolved;
  return { ...resolved, ...original };
}

function schemaType(schema: JsonSchemaValue): string {
  if (typeof schema === 'boolean') return schema ? 'any' : 'never';
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  if (
    isObject(schema.properties) ||
    isObject(schema.patternProperties) ||
    'required' in schema ||
    'additionalProperties' in schema
  )
    return 'object';
  if ('items' in schema || 'prefixItems' in schema) return 'array';
  if (typeof schema.$ref === 'string') return '$ref';
  if ('enum' in schema) return 'enum';
  if ('const' in schema) return 'const';
  return 'any';
}

function schemaTypeToken(schema: JsonSchemaValue): string {
  if (typeof schema === 'boolean') return schema ? 'any' : 'never';
  if (Array.isArray(schema.type)) return 'union';
  if (typeof schema.type === 'string') return schema.type === 'integer' ? 'number' : schema.type;
  if (
    isObject(schema.properties) ||
    isObject(schema.patternProperties) ||
    'required' in schema ||
    'additionalProperties' in schema
  )
    return 'object';
  if ('items' in schema || 'prefixItems' in schema) return 'array';
  if (typeof schema.$ref === 'string') return 'ref';
  if ('enum' in schema || 'const' in schema) return 'enum';
  return 'plain';
}

function requiredProperties(schema: JsonSchemaObject) {
  return new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [],
  );
}

function schemaChildren(
  schema: JsonSchemaValue,
  itemsLabel: string,
  parentPath: string,
): SchemaChild[] {
  if (typeof schema === 'boolean') return [];

  const children: SchemaChild[] = [];
  const required = requiredProperties(schema);

  if (isObject(schema.properties)) {
    for (const [label, child] of Object.entries(schema.properties)) {
      if (isSchemaValue(child))
        children.push({
          label,
          path: `${parentPath}/properties/${pointerSegment(label)}`,
          schema: child,
          required: required.has(label),
          kind: 'property',
        });
    }
  }

  if (isObject(schema.patternProperties)) {
    for (const [label, child] of Object.entries(schema.patternProperties)) {
      if (isSchemaValue(child))
        children.push({
          label,
          path: `${parentPath}/patternProperties/${pointerSegment(label)}`,
          schema: child,
          kind: 'property',
        });
    }
  }

  const items = schema.items;
  if (isSchemaValue(items) && isObject(items)) {
    children.push({ label: itemsLabel, path: `${parentPath}/items`, schema: items, kind: 'index' });
  } else if (Array.isArray(items)) {
    items.forEach((item, index) => {
      if (isSchemaValue(item))
        children.push({
          label: `${itemsLabel}[${index}]`,
          path: `${parentPath}/items/${index}`,
          schema: item,
          kind: 'index',
        });
    });
  } else if (items === true || items === false) {
    children.push({
      label: itemsLabel,
      path: `${parentPath}/items`,
      schema: items,
      kind: 'index',
    });
  }

  if (Array.isArray(schema.prefixItems)) {
    schema.prefixItems.forEach((item, index) => {
      if (isSchemaValue(item))
        children.push({
          label: `prefixItems[${index}]`,
          path: `${parentPath}/prefixItems/${index}`,
          schema: item,
          kind: 'index',
        });
    });
  }

  for (const keyword of COMPOSITION_KEYWORDS) {
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives)) continue;
    alternatives.forEach((item, index) => {
      if (isSchemaValue(item))
        children.push({
          label: `${keyword}[${index}]`,
          path: `${parentPath}/${keyword}/${index}`,
          schema: item,
          kind: 'composition',
        });
    });
  }

  for (const keyword of DEFINITION_KEYWORDS) {
    const definitions = schema[keyword];
    if (!isObject(definitions)) continue;
    for (const [label, child] of Object.entries(definitions)) {
      if (isSchemaValue(child))
        children.push({
          label: `${keyword}.${label}`,
          path: `${parentPath}/${keyword}/${pointerSegment(label)}`,
          schema: child,
          kind: 'definition',
        });
    }
  }

  for (const keyword of KEYWORD_CHILD_KEYS) {
    const child = schema[keyword];
    if (isObject(child))
      children.push({
        label: keyword,
        path: `${parentPath}/${keyword}`,
        schema: child,
        kind: 'keyword',
      });
  }

  return children;
}

function schemaIsContainer(schema: JsonSchemaValue): boolean {
  if (typeof schema === 'boolean') return false;
  return (
    isObject(schema.properties) ||
    isObject(schema.patternProperties) ||
    isObject(schema.$defs) ||
    isObject(schema.definitions) ||
    isObject(schema.dependentSchemas) ||
    'items' in schema ||
    'prefixItems' in schema ||
    Array.isArray(schema.allOf) ||
    Array.isArray(schema.anyOf) ||
    Array.isArray(schema.oneOf)
  );
}

function compactValue(value: unknown, quote = false): string {
  if (typeof value === 'string') return quote ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 56 ? `${text.slice(0, 53)}…` : text;
  } catch {
    return '';
  }
}

function formatMeta(keyword: string, raw: unknown): SchemaMeta | null {
  if (raw === undefined) return null;

  switch (keyword) {
    case 'enum': {
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const values = raw.map((value) => compactValue(value, true));
      const shown = values.slice(0, 6);
      const overflow = values.length - shown.length;
      return {
        keyword,
        value: overflow > 0 ? `${shown.join(' | ')} +${overflow}` : shown.join(' | '),
        full: values.join(' | '),
      };
    }
    case 'const':
    case 'default':
      return { keyword, value: compactValue(raw, true) };
    case 'pattern':
      return typeof raw === 'string' ? { keyword, value: raw } : null;
    case 'format':
      return typeof raw === 'string' ? { keyword, value: raw } : null;
    case 'readOnly':
    case 'writeOnly':
    case 'deprecated':
    case 'uniqueItems':
      return raw === true ? { keyword } : null;
    case 'additionalProperties':
    case 'unevaluatedProperties':
    case 'unevaluatedItems':
      return typeof raw === 'boolean' ? { keyword, value: String(raw) } : null;
    default:
      if (typeof raw === 'string') return { keyword, value: raw };
      if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null)
        return { keyword, value: String(raw) };
      return { keyword, value: compactValue(raw) };
  }
}

function collectSchemaMeta(...schemas: JsonSchemaValue[]): SchemaMeta[] {
  const entries: SchemaMeta[] = [];
  const seen = new Set<string>();
  for (const keyword of META_ORDER) {
    for (const schema of schemas) {
      if (typeof schema === 'boolean' || seen.has(keyword) || !(keyword in schema)) continue;
      const meta = formatMeta(keyword, schema[keyword]);
      if (meta) {
        entries.push(meta);
        seen.add(keyword);
      }
    }
  }
  return entries;
}

function schemaFieldCount(schema: JsonSchemaValue): number {
  return isObject(schema) && isObject(schema.properties)
    ? Object.keys(schema.properties).length
    : 0;
}

function schemaItemCount(schema: JsonSchemaValue): number {
  if (!isObject(schema)) return 0;
  if (Array.isArray(schema.prefixItems)) return schema.prefixItems.length;
  if (Array.isArray(schema.items)) return schema.items.length;
  return 0;
}

function schemaContainerCount(schema: JsonSchemaValue, t: Translate): string {
  const fields = schemaFieldCount(schema);
  if (fields) return t('jsonTool.schemaPreviewFieldCount', { total: fields });
  const items = schemaItemCount(schema);
  if (items) return t('jsonTool.schemaPreviewItemCount', { total: items });
  return '';
}

function schemaStats(schema: JsonSchemaValue, t: Translate): string[] {
  const stats: string[] = [];
  const fields = schemaFieldCount(schema);
  if (fields) stats.push(t('jsonTool.schemaPreviewFieldCount', { total: fields }));
  if (isObject(schema)) {
    const required = requiredProperties(schema).size;
    if (required) stats.push(t('jsonTool.schemaPreviewRequiredCount', { total: required }));
  }
  const items = schemaItemCount(schema);
  if (items) stats.push(t('jsonTool.schemaPreviewItemCount', { total: items }));
  return stats;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  const lower = text.toLowerCase();
  let total = 0;
  let index = 0;
  for (;;) {
    const found = lower.indexOf(needle, index);
    if (found === -1) break;
    total += 1;
    index = found + needle.length;
  }
  return total;
}

function Highlight({
  text,
  query,
  startId,
  currentId,
}: {
  text: string;
  query: string;
  startId?: number;
  currentId?: number;
}) {
  const needle = query.trim().toLowerCase();
  if (!needle) return <>{text}</>;

  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let index = 0;
  let offset = 0;
  let key = 0;

  while (index < text.length) {
    const found = lower.indexOf(needle, index);
    if (found === -1) {
      parts.push(text.slice(index));
      break;
    }
    if (found > index) parts.push(text.slice(index, found));
    const id = startId == null ? undefined : startId + offset;
    parts.push(
      <mark
        key={key}
        className={`json-schema-mark${id != null && id === currentId ? ' is-current' : ''}`}
        {...(id == null ? {} : { 'data-match-id': id })}
      >
        {text.slice(found, found + needle.length)}
      </mark>,
    );
    key += 1;
    offset += 1;
    index = found + needle.length;
  }

  return <>{parts}</>;
}

function schemaNodeTitle(schema: JsonSchemaValue): string {
  return isObject(schema) && typeof schema.title === 'string' ? schema.title : '';
}

function schemaNodeDescription(schema: JsonSchemaValue): string {
  return isObject(schema) && typeof schema.description === 'string' ? schema.description : '';
}

function computeMatches(
  root: JsonSchemaValue,
  query: string,
  externalRefs: ReadonlyMap<string, ExternalRefState>,
  itemsLabel: string,
): SchemaMatches {
  const document: SchemaDocument = { root, key: '$root', baseUrl: schemaBaseUrl(root) };
  const starts = new Map<string, number>();
  const pathsById: string[] = [];
  const needle = query.trim().toLowerCase();
  let count = 0;

  const register = (key: string, text: string, path: string): void => {
    const occurrences = countOccurrences(text, needle);
    if (occurrences === 0) return;
    starts.set(key, count);
    for (let index = 0; index < occurrences; index += 1) pathsById.push(path);
    count += occurrences;
  };

  register('header:title', schemaNodeTitle(root), '#');
  register('header:description', schemaNodeDescription(root), '#');

  const visit = (
    path: string,
    label: string,
    schema: JsonSchemaValue,
    doc: SchemaDocument,
    refStack: string[],
  ): void => {
    const resolved = resolveSchemaValue(schema, doc, refStack, externalRefs);
    const displaySchema = mergeResolvedSchema(schema, resolved.schema);
    register(`${path}::label`, label, path);
    for (const meta of collectSchemaMeta(schema, resolved.schema)) {
      register(`${path}::meta:${meta.keyword}:key`, meta.keyword, path);
      if (meta.value) register(`${path}::meta:${meta.keyword}:value`, meta.value, path);
    }
    register(`${path}::title`, schemaNodeTitle(displaySchema), path);
    register(`${path}::description`, schemaNodeDescription(displaySchema), path);

    for (const child of schemaChildren(displaySchema, itemsLabel, path)) {
      visit(child.path, child.label, child.schema, resolved.document, resolved.refStack);
    }
  };

  visit('#', '$', root, document, []);
  return { count, starts, pathsById };
}

function SchemaMetaChip({
  meta,
  external,
  onLoad,
  t,
  query,
  keyStart,
  valueStart,
  currentId,
}: {
  meta: SchemaMeta;
  external?: { reference: ExternalReference; state?: ExternalRefState };
  onLoad: (reference: ExternalReference) => void;
  t: Translate;
  query: string;
  keyStart?: number;
  valueStart?: number;
  currentId: number;
}) {
  const externalState = external?.state;
  const key = (
    <span className="json-schema-chip-key">
      <Highlight text={meta.keyword} query={query} startId={keyStart} currentId={currentId} />
    </span>
  );
  const value = meta.value ? (
    <span className="json-schema-chip-value">
      <Highlight text={meta.value} query={query} startId={valueStart} currentId={currentId} />
    </span>
  ) : null;

  if (meta.keyword === '$ref' && external) {
    const label =
      externalState?.status === 'loading'
        ? t('jsonTool.schemaPreviewLoadingRef')
        : externalState?.status === 'error'
          ? t('jsonTool.schemaPreviewRetryRef')
          : t('jsonTool.schemaPreviewLoadRef');
    return (
      <button
        type="button"
        className="json-schema-chip is-ref"
        disabled={externalState?.status === 'loading'}
        aria-label={label}
        title={label}
        onClick={() => onLoad(external.reference)}
      >
        {externalState?.status === 'loading' ? <Spinner className="size-3" /> : null}
        {key}
        {value}
      </button>
    );
  }

  return (
    <span className="json-schema-chip" title={meta.full ?? meta.value ?? meta.keyword}>
      {key}
      {value}
    </span>
  );
}

const SchemaNode = memo(function SchemaNode({
  label,
  path,
  kind = 'property',
  schema,
  required = false,
  depth,
  t,
  isRoot = false,
  document,
  refStack,
  externalRefs,
  onLoadExternalRef,
  matches,
  query,
  currentId,
  expandTarget,
  treeCommand,
}: {
  label: string;
  path: string;
  kind?: SchemaChildKind;
  schema: JsonSchemaValue;
  required?: boolean;
  depth: number;
  t: Translate;
  isRoot?: boolean;
  document: SchemaDocument;
  refStack: string[];
  externalRefs: ReadonlyMap<string, ExternalRefState>;
  onLoadExternalRef: (reference: ExternalReference) => void;
  matches: SchemaMatches | null;
  query: string;
  currentId: number;
  expandTarget: ExpandTarget | null;
  treeCommand: TreeCommand | null;
}) {
  const resolved = resolveSchemaValue(schema, document, refStack, externalRefs);
  const displaySchema = mergeResolvedSchema(schema, resolved.schema);
  const children = schemaChildren(displaySchema, t('jsonTool.schemaPreviewItems'), path);
  const [expanded, setExpanded] = useState(() => depth < 2);
  const type = schemaType(displaySchema);
  const typeToken = schemaTypeToken(displaySchema);
  const metas = collectSchemaMeta(schema, resolved.schema);
  const count = schemaContainerCount(displaySchema, t);
  const title =
    typeof displaySchema === 'object' && typeof displaySchema.title === 'string'
      ? displaySchema.title
      : '';
  const description =
    typeof displaySchema === 'object' && typeof displaySchema.description === 'string'
      ? displaySchema.description
      : '';
  const nodeStyle = { '--schema-depth': depth } as CSSProperties;
  const fieldStart = (field: string) => matches?.starts.get(`${path}::${field}`);

  useEffect(() => {
    if (!treeCommand) return;
    setExpanded(treeCommand.expanded);
  }, [treeCommand]);

  useEffect(() => {
    if (!expandTarget) return;
    if (expandTarget.path === path || expandTarget.path.startsWith(`${path}/`)) {
      setExpanded(true);
    }
  }, [expandTarget, path]);

  const hasChildren = children.length > 0;
  const toggleLabel = expanded
    ? t('jsonTool.schemaPreviewCollapse')
    : t('jsonTool.schemaPreviewExpand');

  return (
    <div
      className="json-schema-node"
      style={nodeStyle}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
    >
      <div className="json-schema-node-row">
        <span className="json-schema-node-toggle-slot">
          {hasChildren ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="json-schema-node-toggle"
              aria-label={toggleLabel}
              title={toggleLabel}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? <CaretDown weight="duotone" /> : <CaretRight weight="duotone" />}
            </Button>
          ) : null}
        </span>
        <span
          className={`json-schema-node-name${kind !== 'property' ? ' is-meta' : ''}`}
          title={path}
        >
          <span className={`json-schema-node-key${isRoot ? ' is-root' : ''}`}>
            <Highlight
              text={label}
              query={query}
              startId={fieldStart('label')}
              currentId={currentId}
            />
          </span>
        </span>
        <span className="json-schema-node-type" data-type={typeToken}>
          {type}
        </span>
        <span className="json-schema-node-flags">
          {required ? (
            <span className="json-schema-node-required">{t('jsonTool.schemaPreviewRequired')}</span>
          ) : null}
        </span>
        <span className="json-schema-node-meta">
          {count && !isRoot ? <span className="json-schema-chip is-count">{count}</span> : null}
          {metas.map((meta) => (
            <SchemaMetaChip
              key={meta.keyword}
              meta={meta}
              external={resolved.external}
              onLoad={onLoadExternalRef}
              t={t}
              query={query}
              keyStart={fieldStart(`meta:${meta.keyword}:key`)}
              valueStart={fieldStart(`meta:${meta.keyword}:value`)}
              currentId={currentId}
            />
          ))}
          {resolved.external?.state?.status === 'error' ? (
            <span className="json-schema-ref-error">
              {t('jsonTool.schemaPreviewRefLoadFailed')}
            </span>
          ) : null}
        </span>
      </div>
      {(title || description) && !isRoot ? (
        <p className="json-schema-node-description">
          {title ? (
            <span className="json-schema-node-title">
              <Highlight
                text={title}
                query={query}
                startId={fieldStart('title')}
                currentId={currentId}
              />
            </span>
          ) : null}
          <Highlight
            text={description}
            query={query}
            startId={fieldStart('description')}
            currentId={currentId}
          />
        </p>
      ) : null}
      {expanded && hasChildren ? (
        <div className="json-schema-node-children" role="group">
          {children.map((child) => (
            <SchemaNode
              key={child.path}
              label={child.label}
              path={child.path}
              kind={child.kind}
              schema={child.schema}
              required={child.required}
              depth={depth + 1}
              t={t}
              document={resolved.document}
              refStack={resolved.refStack}
              externalRefs={externalRefs}
              onLoadExternalRef={onLoadExternalRef}
              matches={matches}
              query={query}
              currentId={currentId}
              expandTarget={expandTarget}
              treeCommand={treeCommand}
            />
          ))}
        </div>
      ) : null}
      {schemaIsContainer(displaySchema) && !hasChildren ? (
        <div className="json-schema-node-empty">{t('jsonTool.schemaPreviewNoProperties')}</div>
      ) : null}
    </div>
  );
});

function SchemaSearchBar({
  t,
  count,
  current,
  onApply,
  onPrev,
  onNext,
}: {
  t: Translate;
  count: number;
  current: number;
  onApply: (value: string) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [draft, setDraft] = useState('');

  const clear = () => {
    setDraft('');
    onApply('');
  };

  return (
    <>
      <div className="relative flex w-full min-w-0 flex-1 items-center">
        <MagnifyingGlass
          className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
          weight="duotone"
          aria-hidden="true"
        />
        <Input
          className="h-7 pl-7 text-xs"
          value={draft}
          placeholder={t('jsonTool.schemaPreviewSearchPlaceholder')}
          aria-label={t('jsonTool.schemaPreviewSearch')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onApply(draft.trim());
            } else if (event.key === 'Escape') {
              event.preventDefault();
              clear();
            }
          }}
        />
        {draft ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute right-0.5"
            aria-label={t('jsonTool.schemaPreviewSearchClear')}
            title={t('jsonTool.schemaPreviewSearchClear')}
            onClick={clear}
          >
            <X weight="duotone" />
          </Button>
        ) : null}
      </div>
      {count > 0 || current > 0 ? (
        <span className="flex-none font-mono text-[10px] leading-none text-muted-foreground tabular-nums">
          {t('jsonTool.schemaPreviewMatchPosition', { current, total: count })}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={count === 0}
        aria-label={t('jsonTool.schemaPreviewPrevMatch')}
        title={t('jsonTool.schemaPreviewPrevMatch')}
        onClick={onPrev}
      >
        <CaretUp weight="duotone" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={count === 0}
        aria-label={t('jsonTool.schemaPreviewNextMatch')}
        title={t('jsonTool.schemaPreviewNextMatch')}
        onClick={onNext}
      >
        <CaretDown weight="duotone" />
      </Button>
    </>
  );
}

export function JsonSchemaPreview({ value }: { value: unknown }) {
  const { t } = useTranslation();
  const [externalRefs, setExternalRefs] = useState<Map<string, ExternalRefState>>(() => new Map());
  const externalRefsRef = useRef(externalRefs);
  const controllersRef = useRef(new Map<string, AbortController>());
  const mountedRef = useRef(true);
  const commandIdRef = useRef(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const expandIdRef = useRef(0);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [expandTarget, setExpandTarget] = useState<ExpandTarget | null>(null);
  const [treeCommand, setTreeCommand] = useState<TreeCommand | null>(null);

  useEffect(
    () => () => {
      mountedRef.current = false;
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
    },
    [],
  );

  const loadExternalRef = useCallback((reference: ExternalReference) => {
    const existing = externalRefsRef.current.get(reference.key);
    if (existing?.status === 'loading' || existing?.status === 'loaded') return;

    const controller = new AbortController();
    const loading: ExternalRefState = { status: 'loading' };
    externalRefsRef.current.set(reference.key, loading);
    controllersRef.current.set(reference.key, controller);
    setExternalRefs(new Map(externalRefsRef.current));

    void fetchExternalReference(reference, controller.signal).then(
      (result) => {
        controllersRef.current.delete(reference.key);
        const loaded: ExternalRefState = {
          status: 'loaded',
          schema: result.schema,
          document: result.document,
        };
        externalRefsRef.current.set(reference.key, loaded);
        if (mountedRef.current) setExternalRefs(new Map(externalRefsRef.current));
      },
      () => {
        controllersRef.current.delete(reference.key);
        externalRefsRef.current.set(reference.key, { status: 'error' });
        if (mountedRef.current) setExternalRefs(new Map(externalRefsRef.current));
      },
    );
  }, []);

  const itemsLabel = t('jsonTool.schemaPreviewItems');
  const matches = useMemo(() => {
    if (!query || !isJsonSchema(value)) return null;
    return computeMatches(value, query, externalRefs, itemsLabel);
  }, [value, query, externalRefs, itemsLabel]);

  const document = useMemo<SchemaDocument>(
    () => ({
      root: (isJsonSchema(value) ? value : {}) as JsonSchemaValue,
      key: '$root',
      baseUrl: isJsonSchema(value) ? schemaBaseUrl(value) : undefined,
    }),
    [value],
  );

  const currentId = matches && matches.count > 0 ? Math.min(matchIndex, matches.count - 1) : -1;

  useEffect(() => {
    setMatchIndex(0);
  }, [query]);

  useEffect(() => {
    if (currentId < 0 || !matches) return;
    const path = matches.pathsById[currentId];
    if (!path) return;
    expandIdRef.current += 1;
    setExpandTarget({ id: expandIdRef.current, path });
  }, [currentId, matches]);

  useEffect(() => {
    const container = treeRef.current;
    if (currentId < 0 || !container) return;

    let attempts = 0;
    let frame = requestAnimationFrame(function step() {
      const target = container.querySelector<HTMLElement>(`[data-match-id="${currentId}"]`);
      if (target) {
        const margin = 8;
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const targetCenter = targetRect.top + targetRect.height / 2;
        const containerCenter = containerRect.top + containerRect.height / 2;
        container.scrollTop += targetCenter - containerCenter;
        if (targetRect.left < containerRect.left + margin) {
          container.scrollLeft += targetRect.left - (containerRect.left + margin);
        } else if (targetRect.right > containerRect.right - margin) {
          container.scrollLeft += targetRect.right - (containerRect.right - margin);
        }
        return;
      }
      if (attempts < 6) {
        attempts += 1;
        frame = requestAnimationFrame(step);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [matches, currentId]);

  if (!isJsonSchema(value)) return null;

  const title = typeof value.title === 'string' ? value.title : '';
  const description = typeof value.description === 'string' ? value.description : '';
  const dialect = typeof value.$schema === 'string' ? value.$schema : '';
  const stats = schemaStats(value, t);

  const applySearch = (next: string) => {
    setMatchIndex(0);
    setQuery(next.trim());
  };

  const goToMatch = (delta: number) => {
    if (!matches || matches.count === 0) return;
    setMatchIndex((current) => (current + delta + matches.count) % matches.count);
  };

  const runTreeCommand = (expanded: boolean) => {
    commandIdRef.current += 1;
    setTreeCommand({ id: commandIdRef.current, expanded });
  };

  return (
    <div className="json-schema-preview">
      <div className="json-schema-top">
        <div className="json-schema-header">
          <div className="json-schema-header-main">
            <span className="json-schema-header-title">
              {title ? (
                <Highlight
                  text={title}
                  query={query}
                  startId={matches?.starts.get('header:title')}
                  currentId={currentId}
                />
              ) : (
                t('jsonTool.schemaPreviewTitle')
              )}
            </span>
            <span className="json-schema-node-type" data-type={schemaTypeToken(value)}>
              {schemaType(value)}
            </span>
            {stats.length ? (
              <span className="json-schema-header-stats">{stats.join(' · ')}</span>
            ) : null}
            {dialect ? <code className="json-schema-header-dialect">{dialect}</code> : null}
          </div>
          {description ? (
            <p className="json-schema-header-description">
              <Highlight
                text={description}
                query={query}
                startId={matches?.starts.get('header:description')}
                currentId={currentId}
              />
            </p>
          ) : null}
        </div>
        <div className="flex w-full flex-none items-center gap-2 border-b border-border px-0.5 py-2">
          <SchemaSearchBar
            t={t}
            count={matches?.count ?? 0}
            current={matches && matches.count ? currentId + 1 : 0}
            onApply={applySearch}
            onPrev={() => goToMatch(-1)}
            onNext={() => goToMatch(1)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('jsonTool.schemaPreviewExpandAll')}
            title={t('jsonTool.schemaPreviewExpandAll')}
            onClick={() => runTreeCommand(true)}
          >
            <ArrowsOutLineVertical weight="duotone" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('jsonTool.schemaPreviewCollapseAll')}
            title={t('jsonTool.schemaPreviewCollapseAll')}
            onClick={() => runTreeCommand(false)}
          >
            <ArrowsInLineVertical weight="duotone" />
          </Button>
        </div>
      </div>
      <div
        className="json-schema-tree"
        ref={treeRef}
        role="tree"
        aria-label={t('jsonTool.schemaPreviewTitle')}
      >
        <SchemaNode
          label="$"
          path="#"
          schema={value}
          depth={0}
          t={t}
          isRoot
          document={document}
          refStack={EMPTY_REF_STACK}
          externalRefs={externalRefs}
          onLoadExternalRef={loadExternalRef}
          matches={matches}
          query={query}
          currentId={currentId}
          expandTarget={expandTarget}
          treeCommand={treeCommand}
        />
      </div>
    </div>
  );
}
