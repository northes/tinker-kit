export type JsonConvertFormat = 'yaml' | 'xml' | 'toml' | 'csv';

export type JsonConvertErrorCode =
  | 'invalidJson'
  | 'jsonComments'
  | 'unsafeInteger'
  | 'unsupportedFormat'
  | 'unsupportedType'
  | 'unsupportedNumber'
  | 'tomlRoot'
  | 'tomlNull'
  | 'xmlInvalidName'
  | 'xmlInvalidCharacter'
  | 'csvMixedRows';

export const JSON_CONVERT_FORMATS: readonly JsonConvertFormat[] = ['yaml', 'xml', 'toml', 'csv'];
