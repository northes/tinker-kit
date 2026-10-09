export function stripJsonComments(source: string) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++;
      out += '\n';
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/'))
        index++;
      index++;
      continue;
    }
    out += char;
  }
  return out;
}

export function stripTrailingCommas(source: string) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next++;
      if (source[next] === '}' || source[next] === ']') continue;
    }
    out += char;
  }
  return out;
}

export function parseJsonLoose(source: string) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(source)));
}

/** 只容忍注释（JSONC）；其他语法错误交给显式修复流程。 */
