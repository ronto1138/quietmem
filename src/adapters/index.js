import claudeCode from './claude-code.js';
import jsonl from './jsonl.js';

const ADAPTERS = { [claudeCode.name]: claudeCode, [jsonl.name]: jsonl };

export function getAdapter(name) {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`unknown adapter "${name}" (available: ${Object.keys(ADAPTERS).join(', ')})`);
  return a;
}

export const adapterNames = () => Object.keys(ADAPTERS);
