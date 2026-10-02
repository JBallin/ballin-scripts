// Public operations shared by dispatch and completion generation; no runtime imports.
const configOperationNames = ['get', 'set', 'reset'] as const;

export type ConfigOperationName = typeof configOperationNames[number];

const isConfigOperationName = (value: unknown): value is ConfigOperationName => (
  typeof value === 'string' && configOperationNames.some((name) => name === value)
);

module.exports = { configOperationNames, isConfigOperationName };
