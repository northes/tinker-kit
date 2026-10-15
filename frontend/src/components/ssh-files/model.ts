import {
  File,
  FileArchive,
  FileAudio,
  FileC,
  FileCode,
  FileCpp,
  FileCSharp,
  FileCss,
  FileCsv,
  FileDoc,
  FileHtml,
  FileImage,
  FileIni,
  FileJpg,
  FileJs,
  FileJsx,
  FileMd,
  FilePdf,
  FilePng,
  FilePpt,
  FilePy,
  FileRs,
  FileSql,
  FileSvg,
  FileText,
  FileTs,
  FileTsx,
  FileTxt,
  FileVideo,
  FileVue,
  FileXls,
  FileZip,
  type Icon,
} from '@phosphor-icons/react';
import type {
  FileSource,
  FileTask,
  RemoteFileEntry,
  SSHProfile,
} from '../../../bindings/tinkerkit/models';
import { backendErrorKey, formatBackendError, rawErrorMessage } from '../../lib/backend-error';
import { basename } from './paths';
import { type RenameForm } from './rename';

export type ManagedFileSource = FileSource;

export const MANAGE_SOURCES_VALUE = '__manage-sources__';

export function emptyFileSource(sshProfileID = ''): ManagedFileSource {
  return {
    id: '',
    name: '',
    sshProfileID,
    defaultPath: '',
    favoritePaths: [],
  };
}

export function sshProfileListingKey(profile: SSHProfile | null | undefined) {
  if (!profile) return '';
  return [
    profile.origin,
    profile.originAlias,
    profile.host,
    String(profile.port),
    profile.username,
    profile.password,
    profile.privateKey,
    profile.privateKeyPath,
    profile.keyPassphrase,
  ].join('\0');
}

const archiveFileExtensions = new Set([
  '7z',
  'apk',
  'arj',
  'bz',
  'bz2',
  'cab',
  'cpio',
  'deb',
  'dmg',
  'ear',
  'gz',
  'gzip',
  'iso',
  'jar',
  'lz',
  'lz4',
  'lzma',
  'rar',
  'rpm',
  'tar',
  'tbz',
  'tbz2',
  'tgz',
  'txz',
  'war',
  'xz',
  'z',
  'zipx',
  'zst',
]);

const imageFileExtensions = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'ico',
  'jif',
  'jfif',
  'jpe',
  'raw',
  'tif',
  'tiff',
  'webp',
]);

const videoFileExtensions = new Set([
  '3gp',
  'avi',
  'flv',
  'm2ts',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'mxf',
  'ogv',
  'webm',
  'wmv',
]);

const audioFileExtensions = new Set([
  'aac',
  'aiff',
  'alac',
  'amr',
  'flac',
  'm4a',
  'm4b',
  'mid',
  'midi',
  'mp3',
  'oga',
  'ogg',
  'opus',
  'wav',
  'wma',
]);

const codeFileExtensions = new Set([
  'astro',
  'bash',
  'dart',
  'ex',
  'exs',
  'fish',
  'go',
  'graphql',
  'h',
  'hpp',
  'java',
  'json',
  'jl',
  'kt',
  'kts',
  'less',
  'lua',
  'm',
  'mm',
  'php',
  'pl',
  'proto',
  'r',
  'rb',
  'scss',
  'sh',
  'swift',
  'toml',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

const textFileExtensions = new Set([
  'cfg',
  'conf',
  'diff',
  'env',
  'log',
  'patch',
  'properties',
  'rtf',
  'srt',
]);

const fileIconsByExtension = new Map<string, Icon>([
  ['c', FileC],
  ['cc', FileCpp],
  ['cjs', FileJs],
  ['cpp', FileCpp],
  ['cs', FileCSharp],
  ['css', FileCss],
  ['csv', FileCsv],
  ['doc', FileDoc],
  ['docx', FileDoc],
  ['hh', FileCpp],
  ['h', FileC],
  ['htm', FileHtml],
  ['html', FileHtml],
  ['ini', FileIni],
  ['jpeg', FileJpg],
  ['jpg', FileJpg],
  ['js', FileJs],
  ['jsx', FileJsx],
  ['md', FileMd],
  ['markdown', FileMd],
  ['mjs', FileJs],
  ['mts', FileTs],
  ['cts', FileTs],
  ['pdf', FilePdf],
  ['png', FilePng],
  ['ppt', FilePpt],
  ['pptx', FilePpt],
  ['py', FilePy],
  ['rs', FileRs],
  ['sql', FileSql],
  ['svg', FileSvg],
  ['ts', FileTs],
  ['tsx', FileTsx],
  ['txt', FileTxt],
  ['text', FileTxt],
  ['vue', FileVue],
  ['xls', FileXls],
  ['xlsx', FileXls],
]);

function remoteFileExtension(path: string) {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1) : '';
}

export function remoteFileIcon(path: string): Icon {
  const extension = remoteFileExtension(path);
  if (extension === 'zip') return FileZip;
  const extensionIcon = fileIconsByExtension.get(extension);
  if (extensionIcon) return extensionIcon;
  if (archiveFileExtensions.has(extension)) return FileArchive;
  if (imageFileExtensions.has(extension)) return FileImage;
  if (videoFileExtensions.has(extension)) return FileVideo;
  if (audioFileExtensions.has(extension)) return FileAudio;
  if (codeFileExtensions.has(extension)) return FileCode;
  if (textFileExtensions.has(extension)) return FileText;
  return File;
}

export function isEditableTextFile(path: string) {
  const name = basename(path).toLowerCase();
  const extension = remoteFileExtension(path);
  return (
    codeFileExtensions.has(extension) ||
    (textFileExtensions.has(extension) && extension !== 'rtf') ||
    [
      'txt',
      'text',
      'csv',
      'md',
      'markdown',
      'html',
      'htm',
      'css',
      'js',
      'jsx',
      'ts',
      'tsx',
      'c',
      'cc',
      'cpp',
      'cs',
      'py',
      'rs',
      'sql',
      'svg',
      'ini',
      'jsonc',
      'mjs',
      'cjs',
      'mts',
      'cts',
    ].includes(extension) ||
    ['dockerfile', 'makefile', 'readme', '.env', '.gitignore', '.editorconfig', '.npmrc'].includes(
      name,
    ) ||
    name.startsWith('.env.')
  );
}

export function isArchivePath(value: string) {
  const lower = value.toLowerCase();
  return (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz')
  );
}

export function archiveStem(value: string) {
  const name = basename(value);
  const lower = name.toLowerCase();
  for (const extension of ['.tar.gz', '.tgz', '.zip', '.tar']) {
    if (lower.endsWith(extension)) {
      const stem = name.slice(0, -extension.length);
      return stem || name;
    }
  }
  return name;
}

export { formatFileBytes as formatBytes } from '../../lib/byte-format';
export { basename, normalizeRemotePath, remoteParent } from './paths';

export function timestampMillis(value: string) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatRemoteTimestamp(value: string, locale: string) {
  const timestamp = timestampMillis(value);
  return timestamp === null ? '—' : new Date(timestamp).toLocaleString(locale);
}

export function taskPercent(task: FileTask, completed = task.completed) {
  if (!task.total || task.total <= 0) return null;
  return Math.max(0, Math.min(100, (completed / task.total) * 100));
}

export const progressMinCatchUpDuration = 80;

export const progressMaxCatchUpDuration = 800;

export function errorMessage(error: unknown) {
  return formatBackendError(error);
}

export function isRemotePathNotFound(error: unknown) {
  const key = backendErrorKey(error);
  if (key && /notfound|not_found|missing/i.test(key)) return true;
  const message = rawErrorMessage(error).toLowerCase();
  return (
    message.includes('no such file') ||
    /(?:file|directory|path).*(?:does not exist|not found)/.test(message)
  );
}

export type RemoteFileOperation = 'copy' | 'move' | 'rename' | 'delete' | 'extract' | 'compress';

type InputRemoteFileOperation = Exclude<RemoteFileOperation, 'delete'>;

type TransferOperation = Extract<RemoteFileOperation, 'copy' | 'move'>;

export function usesDirectoryTree(operation: InputRemoteFileOperation | undefined) {
  return (
    operation === 'copy' ||
    operation === 'move' ||
    operation === 'compress' ||
    operation === 'extract'
  );
}

export type OperationDialogState = {
  operation: InputRemoteFileOperation;
  paths: string[];
  value: string;
  renameForm?: RenameForm;
} | null;

export type OperationConflictState = {
  taskID: string;
  operation: TransferOperation;
  paths: string[];
  target: string;
  value: string;
  conflicts: string[];
} | null;

export type RemoteOperationRunResult =
  | { status: 'completed' }
  | { status: 'started' }
  | { status: 'conflict'; paths: string[] }
  | { status: 'failed' };

export type FileSortKey = 'name' | 'size' | 'modifiedAt' | 'createdAt';

export type SortDirection = 'asc' | 'desc';

export type RemoteSearchMode = 'name' | 'content';

export type RemoteSearchScope = 'current' | 'recursive';

export type MissingFavoritePath = { sourceID: string; path: string; previousPath: string };

export type LoadingKind = 'sources' | 'directory' | 'search';

export type DirectoryLoadingPhase = 'connecting' | 'loadingDirectory';

export type CachedDirectoryListing = {
  cachedAt: number;
  requestID: number;
  path: string;
  entries: RemoteFileEntry[];
};

export type CancellableCall = {
  cancel: (cause?: unknown) => PromiseLike<void> | void;
};

export const DIRECTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function directoryListingKey(
  sourceID: string,
  sshProfileID: string,
  profileKey: string,
  remotePath: string,
  showHidden: boolean,
) {
  return [sourceID, sshProfileID, profileKey, remotePath, showHidden ? '1' : '0'].join('\0');
}

export { buildRenamePreview } from './rename';
