export type ParsedCurlRequest = {
  target: string;
  method: string;
  headers: string;
  body: string;
  hasBody: boolean;
  maxRedirects: number;
  skipTLSVerify: boolean;
  timeoutSeconds?: number;
};

export type CurlCommandParseErrorCode =
  | 'empty'
  | 'syntax'
  | 'command'
  | 'urlMissing'
  | 'urlMultiple'
  | 'unsupportedOption'
  | 'fileReference'
  | 'redirectLimit'
  | 'timeout';

export class CurlCommandParseError extends Error {
  constructor(
    readonly code: CurlCommandParseErrorCode,
    readonly option = '',
  ) {
    super(code);
  }
}

function tokenize(command: string) {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: "'" | '"' | null = null;

  const push = () => {
    if (!started) return;
    tokens.push(token);
    token = '';
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];

    if (quote === "'") {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === '\\' && next && ['"', '\\', '$', '`', '\n'].includes(next)) {
        index += 1;
        if (next !== '\n') token += next;
      } else {
        token += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === '\\') {
      if (!next) throw new CurlCommandParseError('syntax');
      index += 1;
      if (next !== '\n') token += next;
      started = true;
      continue;
    }
    if (character === '#' && !started) {
      while (index < command.length && command[index] !== '\n') index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    if (';&|<>`'.includes(character)) throw new CurlCommandParseError('syntax');
    token += character;
    started = true;
  }

  if (quote) throw new CurlCommandParseError('syntax');
  push();
  return tokens;
}

function base64UTF8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function parseCurlCommand(command: string): ParsedCurlRequest {
  const tokens = tokenize(command.trim());
  if (!tokens.length) throw new CurlCommandParseError('empty');
  const executable = tokens[0].split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (executable !== 'curl' && executable !== 'curl.exe') {
    throw new CurlCommandParseError('command');
  }

  let target = '';
  let method = '';
  let explicitMethod = false;
  let headers: string[] = [];
  const data: string[] = [];
  let hasBody = false;
  let isJSON = false;
  let useGet = false;
  let followRedirects = false;
  let maxRedirects = 10;
  let skipTLSVerify = false;
  let timeoutSeconds: number | undefined;
  let index = 1;

  const addHeader = (header: string, option: string) => {
    if (header.startsWith('@') || !header.includes(':')) {
      throw new CurlCommandParseError('fileReference', option);
    }
    headers.push(header);
  };
  const readValue = (option: string, inlineValue?: string) => {
    if (inlineValue !== undefined) return inlineValue;
    const next = tokens[index + 1];
    if (next === undefined) throw new CurlCommandParseError('syntax', option);
    index += 1;
    return next;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    let option = token;
    let inlineValue: string | undefined;
    if (token.startsWith('--') && token.includes('=')) {
      [option, inlineValue] = [
        token.slice(0, token.indexOf('=')),
        token.slice(token.indexOf('=') + 1),
      ];
    }

    if (option === '--url' || option === '-url') {
      const value = readValue(option, inlineValue);
      if (target) throw new CurlCommandParseError('urlMultiple');
      target = value;
    } else if (option === '--request' || option === '-X') {
      method = readValue(option, inlineValue);
      explicitMethod = true;
    } else if (option.startsWith('-X') && option.length > 2) {
      method = option.slice(2);
      explicitMethod = true;
    } else if (option === '--header' || option === '-H') {
      addHeader(readValue(option, inlineValue), option);
    } else if (option.startsWith('-H') && option.length > 2) {
      addHeader(option.slice(2), '-H');
    } else if (option === '--user-agent' || option === '-A') {
      addHeader(`User-Agent: ${readValue(option, inlineValue)}`, option);
    } else if (option.startsWith('-A') && option.length > 2) {
      addHeader(`User-Agent: ${option.slice(2)}`, '-A');
    } else if (option === '--referer' || option === '-e') {
      addHeader(`Referer: ${readValue(option, inlineValue)}`, option);
    } else if (option === '--cookie' || option === '-b') {
      addHeader(`Cookie: ${readValue(option, inlineValue)}`, option);
    } else if (option === '--user' || option === '-u') {
      const credentials = readValue(option, inlineValue);
      if (credentials.startsWith('@')) throw new CurlCommandParseError('fileReference', option);
      headers.push(`Authorization: Basic ${base64UTF8(credentials)}`);
    } else if (
      option === '--data' ||
      option === '-d' ||
      option === '--data-raw' ||
      option === '--data-binary'
    ) {
      const value = readValue(option, inlineValue);
      if (value.startsWith('@')) throw new CurlCommandParseError('fileReference', option);
      data.push(value);
      hasBody = true;
      if (!explicitMethod) method = 'POST';
    } else if (option === '--json') {
      const value = readValue(option, inlineValue);
      if (value.startsWith('@')) throw new CurlCommandParseError('fileReference', option);
      data.push(value);
      hasBody = true;
      isJSON = true;
      if (!explicitMethod) method = 'POST';
    } else if (option === '--get' || option === '-G') {
      useGet = true;
    } else if (option === '--head' || option === '-I') {
      method = 'HEAD';
      explicitMethod = true;
    } else if (option === '--location' || option === '-L') {
      followRedirects = true;
    } else if (option === '--max-redirs') {
      const value = Number(readValue(option, inlineValue));
      if (!Number.isInteger(value) || value < 0 || value > 10) {
        throw new CurlCommandParseError('redirectLimit');
      }
      maxRedirects = value;
    } else if (option === '--max-time' || option === '-m') {
      const value = Number(readValue(option, inlineValue));
      if (!Number.isFinite(value) || value < 1 || value > 300) {
        throw new CurlCommandParseError('timeout');
      }
      timeoutSeconds = Math.ceil(value);
    } else if (option === '--insecure' || option === '-k') {
      skipTLSVerify = true;
    } else if (
      [
        '--silent',
        '-s',
        '--show-error',
        '-S',
        '--verbose',
        '-v',
        '--include',
        '-i',
        '--compressed',
        '--fail',
        '--fail-with-body',
        '--globoff',
        '--path-as-is',
        '--http1.1',
        '--no-buffer',
        '--raw',
      ].includes(option)
    ) {
      // These flags affect curl's presentation or transport negotiation, which the tool handles itself.
    } else if (token.startsWith('-')) {
      throw new CurlCommandParseError('unsupportedOption', option);
    } else if (target) {
      throw new CurlCommandParseError('urlMultiple');
    } else {
      target = token;
    }
    index += 1;
  }

  if (!target) throw new CurlCommandParseError('urlMissing');
  if (!method) method = hasBody ? 'POST' : 'GET';
  let body = data.join('&');
  if (useGet && hasBody) {
    try {
      const parsed = new URL(target.includes('://') ? target : `http://${target}`);
      const query = [parsed.search.replace(/^\?/, ''), body].filter(Boolean).join('&');
      parsed.search = query;
      target = parsed.toString();
      method = explicitMethod ? method : 'GET';
      body = '';
      hasBody = false;
    } catch {
      throw new CurlCommandParseError('urlMissing');
    }
  }
  if (isJSON) {
    if (!headers.some((header) => /^content-type\s*:/i.test(header))) {
      headers.push('Content-Type: application/json');
    }
    if (!headers.some((header) => /^accept\s*:/i.test(header))) {
      headers.push('Accept: application/json');
    }
  } else if (hasBody && !headers.some((header) => /^content-type\s*:/i.test(header))) {
    headers.push('Content-Type: application/x-www-form-urlencoded');
  }

  return {
    target,
    method,
    headers: headers.join('\n'),
    body,
    hasBody,
    maxRedirects: followRedirects ? maxRedirects : 0,
    skipTLSVerify,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}
