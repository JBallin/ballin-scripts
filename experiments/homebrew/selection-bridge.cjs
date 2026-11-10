// Pure experiment gate. It does not resolve selectors, invoke Brew or run setup.
function assertExactSelection(selection, metadata, { formula, nodeMajor } = {}) {
  const version = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
  const sha = /^[a-f0-9]{40}$/;
  const id = /^[1-9]\d*$/;
  if (selection?.kind !== 'release') throw Error('Homebrew experiment supports exact published releases only; branch and SHA selectors require the direct route. No fallback selected.');
  if (typeof selection.value !== 'string' || !selection.value.startsWith('v') || !version.test(selection.value.slice(1))
    || !sha.test(selection.sha || '') || typeof selection.releaseId !== 'string' || !id.test(selection.releaseId)
    || !version.test(selection.minimumNode || '')) throw Error('Invalid resolved release selection.');
  if (typeof formula !== 'string' || !/^[a-z0-9][a-z0-9+_.@-]*\/[a-z0-9][a-z0-9+_.@-]*\/[a-z0-9][a-z0-9+_.@-]*$/.test(formula)) throw Error('An exact qualified owning formula is required.');
  if (metadata?.manager !== 'homebrew' || metadata.schema !== 3 || metadata.formula !== formula
    || metadata.selection?.kind !== 'release') throw Error('Expected stable Homebrew package ownership/provenance is unavailable.');
  if (metadata.selection.value !== selection.value || metadata.selection.releaseId !== selection.releaseId
    || metadata.sourceRevision !== selection.sha || metadata.version !== selection.value.slice(1)
    || !/^[a-f0-9]{64}$/.test(metadata.archiveSha256 || '')) throw Error('Available package does not match the exact requested release. No latest-version substitution selected.');
  if (metadata.runtime?.minimumNode !== selection.minimumNode || !Number.isSafeInteger(nodeMajor)
    || nodeMajor < Number(selection.minimumNode.split('.')[0]) || metadata.runtime?.nodeMajor !== nodeMajor) throw Error('Package runtime contract does not match the resolved selection.');
  return true;
}
module.exports = { assertExactSelection };
