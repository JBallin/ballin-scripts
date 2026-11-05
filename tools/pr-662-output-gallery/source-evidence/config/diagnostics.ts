const path = require('path');

// Diagnose the path actually supplied to the writer, without reading contents or
// following a link that the backup writer would replace rather than follow.
const configurationPath = (file: string): string => JSON.stringify(path.resolve(file)).replace(
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu,
  (character: string) => Array.from({ length: character.length }, (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''),
);
const filesystemCauses: Record<string, string> = {
  EACCES: 'permission denied', EPERM: 'operation not permitted', EROFS: 'read-only filesystem',
  ENOSPC: 'no space left on the filesystem', EDQUOT: 'storage quota exceeded',
  ENOENT: 'a required file or folder is missing', ENOTDIR: 'a path component is not a folder',
  EISDIR: 'the destination is a folder', EEXIST: 'the private staging path already exists',
  EIO: 'filesystem input/output error', ELOOP: 'too many symbolic links',
};
// Raw messages and error paths may contain private or untrusted data.
const filesystemCause = (error: unknown): string | undefined => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && Object.hasOwn(filesystemCauses, code)
    ? `${code}: ${filesystemCauses[code]}.` : undefined;
};
module.exports = { configurationPath, filesystemCause };
