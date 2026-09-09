import fs from 'node:fs/promises';
import path from 'node:path';

const TEMPLATE = `# Project instructions\n\nDocument project-specific coding conventions, validation commands, architectural constraints, and files that should not be modified.\n`;

export async function initializeProject(workspace, { fileName = 'AGENTS.md' } = {}) {
  const root = path.resolve(workspace);
  const target = path.join(root, fileName);
  try {
    await fs.access(target);
    throw new Error(`${fileName} already exists. It was not overwritten.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(target, TEMPLATE, { encoding: 'utf8', flag: 'wx' });
  return target;
}

export const projectInstructionTemplate = TEMPLATE;
