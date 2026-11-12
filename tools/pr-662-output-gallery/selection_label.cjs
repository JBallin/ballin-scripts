const selectionLabel = (s) => s.kind === 'release' ? s.value : s.kind === 'sha' ? `commit ${s.sha.slice(0, 12)}` : `branch ${s.value} (${s.sha.slice(0, 12)})`;
module.exports={selectionLabel};
