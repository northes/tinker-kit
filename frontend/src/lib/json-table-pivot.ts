/** 表格预览可展示的标量值 */
export type JsonTableScalar = string | number | boolean | null;

/** 普通字段列 */
export type JsonTableFieldColumn = {
  kind: 'field';
  field: string;
};

/** 键值数组展平后的列 */
export type JsonTablePivotColumn = {
  kind: 'pivot';
  arrayField: string;
  nameKey: string;
  valueKey: string;
  /** 表头展示文案 */
  header: string;
  /** 列名键的原始值，供时间格式化等使用 */
  fieldKey: string;
  /** 在数组内用列名键取值匹配行内元素 */
  columnName: string;
};

export type JsonTableColumnPlan = JsonTableFieldColumn | JsonTablePivotColumn;

function isScalar(value: unknown): value is JsonTableScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function setsEqual(a: Set<unknown>, b: Set<unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/** 该键在数组内是否可作为列名键：值均为非空字符串且互不重复 */
function canBeNameKey(items: Record<string, unknown>[], key: string): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const name = item[key];
    if (typeof name !== 'string' || name === '') return false;
    if (seen.has(name)) return false;
    seen.add(name);
  }
  return true;
}

/** 收集一行数组在某个键上的取值集合（忽略空字符串列名） */
function rowValueSet(row: Record<string, unknown>, field: string, key: string): Set<unknown> {
  const raw = row[field];
  if (!Array.isArray(raw) || raw.length === 0) return new Set();
  const set = new Set<unknown>();
  for (const item of raw) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      set.add((item as Record<string, unknown>)[key]);
    }
  }
  return set;
}

type PivotAnalysis =
  | { ok: false }
  | {
      ok: true;
      nameKey: string;
      valueKey: string;
      columnOrder: string[];
    };

function analyzePivotField(rows: Record<string, unknown>[], field: string): PivotAnalysis {
  let keyPair: [string, string] | null = null;

  for (const row of rows) {
    const raw = row[field];
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) continue;
    if (raw === null || !Array.isArray(raw)) return { ok: false };

    for (const item of raw) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return { ok: false };
      const obj = item as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length !== 2) return { ok: false };
      if (!keys.every((k) => isScalar(obj[k]))) return { ok: false };
      if (keyPair === null) {
        keyPair = [keys[0], keys[1]];
      } else {
        const expected = new Set(keyPair);
        if (keys.length !== 2 || !keys.every((k) => expected.has(k))) return { ok: false };
      }
    }
  }

  if (keyPair === null) return { ok: false };

  const [k0, k1] = keyPair;
  const k0AsName = rows.every((row) => {
    const raw = row[field];
    if (!Array.isArray(raw) || raw.length === 0) return true;
    return canBeNameKey(raw as Record<string, unknown>[], k0);
  });
  const k1AsName = rows.every((row) => {
    const raw = row[field];
    if (!Array.isArray(raw) || raw.length === 0) return true;
    return canBeNameKey(raw as Record<string, unknown>[], k1);
  });

  let nameKey: string;
  let valueKey: string;

  if (k0AsName && !k1AsName) {
    nameKey = k0;
    valueKey = k1;
  } else if (!k0AsName && k1AsName) {
    nameKey = k1;
    valueKey = k0;
  } else if (k0AsName && k1AsName) {
    const nonEmptyRows = rows.filter(
      (row) => Array.isArray(row[field]) && (row[field] as unknown[]).length > 0,
    );
    if (nonEmptyRows.length < 2) return { ok: false };

    const signatures0 = nonEmptyRows.map((row) => rowValueSet(row, field, k0));
    const signatures1 = nonEmptyRows.map((row) => rowValueSet(row, field, k1));

    const allSame0 = signatures0.every((set) => setsEqual(set, signatures0[0]!));
    const allSame1 = signatures1.every((set) => setsEqual(set, signatures1[0]!));
    const anyDiff1 = signatures1.some((set, index) => index > 0 && !setsEqual(set, signatures1[0]!));
    const anyDiff0 = signatures0.some((set, index) => index > 0 && !setsEqual(set, signatures0[0]!));

    if (allSame0 && anyDiff1) {
      nameKey = k0;
      valueKey = k1;
    } else if (allSame1 && anyDiff0) {
      nameKey = k1;
      valueKey = k0;
    } else {
      return { ok: false };
    }
  } else {
    return { ok: false };
  }

  const columnOrder: string[] = [];
  const seenColumns = new Set<string>();

  const appendFromArray = (items: Record<string, unknown>[]) => {
    for (const item of items) {
      const name = item[nameKey];
      if (typeof name !== 'string' || name === '' || seenColumns.has(name)) continue;
      seenColumns.add(name);
      columnOrder.push(name);
    }
  };

  for (const row of rows) {
    const raw = row[field];
    if (Array.isArray(raw) && raw.length > 0) {
      appendFromArray(raw as Record<string, unknown>[]);
    }
  }

  if (columnOrder.length === 0) return { ok: false };

  return { ok: true, nameKey, valueKey, columnOrder };
}

function pivotColumnsForField(
  field: string,
  analysis: Extract<PivotAnalysis, { ok: true }>,
  occupied: Set<string>,
): JsonTablePivotColumn[] | null {
  const headers: JsonTablePivotColumn[] = [];
  const next = new Set(occupied);
  for (const columnName of analysis.columnOrder) {
    let header = columnName;
    if (next.has(header)) header = `${field}.${columnName}`;
    if (next.has(header)) return null;
    next.add(header);
    headers.push({
      kind: 'pivot',
      arrayField: field,
      nameKey: analysis.nameKey,
      valueKey: analysis.valueKey,
      header,
      fieldKey: columnName,
      columnName,
    });
  }
  for (const header of headers) occupied.add(header.header);
  return headers;
}

/**
 * 为对象数组横表计划列：开关关闭时与现有行为一致（每字段一列）；
 * 打开时把符合条件的键值数组摊成多列。
 */
export function planJsonTableColumns(
  rows: Record<string, unknown>[],
  enabled: boolean,
): JsonTableColumnPlan[] {
  const fieldOrder: string[] = [];
  const seenFields = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seenFields.has(key)) {
        seenFields.add(key);
        fieldOrder.push(key);
      }
    }
  }

  if (!enabled) {
    return fieldOrder.map((field) => ({ kind: 'field', field }));
  }

  const analyses = new Map<string, PivotAnalysis>();
  for (const field of fieldOrder) analyses.set(field, analyzePivotField(rows, field));

  // 结构上不能展平的字段先占名。前缀冲突后退回的字段会补进这个集合并重算。
  const plain = new Set(fieldOrder.filter((field) => !analyses.get(field)?.ok));
  let columnsByField = new Map<string, JsonTableColumnPlan[]>();
  for (;;) {
    columnsByField = new Map();
    const occupied = new Set(plain);
    let fallback: string | null = null;
    for (const field of fieldOrder) {
      const analysis = analyses.get(field);
      if (!analysis?.ok || plain.has(field)) {
        columnsByField.set(field, [{ kind: 'field', field }]);
        continue;
      }
      const pivoted = pivotColumnsForField(field, analysis, occupied);
      if (!pivoted) {
        fallback = field;
        break;
      }
      columnsByField.set(field, pivoted);
    }
    if (!fallback) break;
    plain.add(fallback);
  }

  return fieldOrder.flatMap((field) => columnsByField.get(field) ?? [{ kind: 'field', field }]);
}

/** 普通列缺字段时保持 undefined；只有展平列找不到列名或没有数组时才返回 null */
export function getJsonTableCellValue(
  row: Record<string, unknown>,
  column: JsonTableColumnPlan,
): unknown {
  if (column.kind === 'field') return row[column.field];

  const raw = row[column.arrayField];
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (obj[column.nameKey] === column.columnName) {
      return column.valueKey in obj ? obj[column.valueKey] : null;
    }
  }
  return null;
}

/**
 * 根据列计划判定哪些列应使用数字对齐（与 ObjectArray 规则一致）。
 */
export function jsonTableNumericColumnKeys(
  rows: Record<string, unknown>[],
  columns: JsonTableColumnPlan[],
): Set<string> {
  const numeric = new Set<string>();
  for (const column of columns) {
    const columnId = column.kind === 'field' ? column.field : column.header;
    let seenNumber = false;
    let allNumeric = true;
    for (const row of rows) {
      const item = getJsonTableCellValue(row, column);
      if (item === undefined || item === null) continue;
      if (typeof item === 'number') seenNumber = true;
      else {
        allNumeric = false;
        break;
      }
    }
    if (seenNumber && allNumeric) numeric.add(columnId);
  }
  return numeric;
}
