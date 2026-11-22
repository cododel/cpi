import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const agentDir = join(homedir(), '.pi', 'agent');
const root = join(agentDir, 'agents');

async function kind(path: string) {
  try { return await stat(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}

async function discover() {
  const profiles = new Map<string, { file: string; folder?: string }>();
  for (const entry of (await readdir(root)).sort()) {
    if (entry.startsWith('.')) continue;
    const path = join(root, entry);
    const info = await kind(path);
    const folder = info?.isDirectory() ? path : undefined;
    if (!folder && !(info?.isFile() && entry.endsWith('.md'))) continue;
    const file = folder ? join(folder, 'agent.md') : path;
    if (folder && !(await kind(file))?.isFile()) continue;
    const name = folder ? entry : entry.slice(0, -3);
    if (profiles.has(name)) throw new Error(`Duplicate agent profile '${name}' in ${root}`);
    profiles.set(name, { file, folder });
  }
  return profiles;
}

export default async function (pi: ExtensionAPI) {
  const profiles = await discover();
  if (!profiles.size) return;
  let active = 0;
  pi.registerTool({
    name: 'subagent', label: 'Delegate research',
    description: 'Run a named read-only agent profile in a fresh pi process and wait for its report. Supply the question, relevant paths/URLs, scope and expected output; conversation history is not inherited. Independent calls may run in parallel (limit two).',
    promptSnippet: 'Delegate substantial independent research to a named subagent; use direct tools for simple lookups',
    parameters: Type.Object({ role: StringEnum([...profiles.keys()]), task: Type.String({ minLength: 1, maxLength: 32000 }) }),
    async execute(_id, { role, task }, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!task.trim()) throw new Error('Empty research task');
      const profile = profiles.get(role);
      if (!profile) throw new Error(`Unknown agent profile: ${role}`);
      if (active >= 2) throw new Error('Two subagents are already running; retry after one finishes');
      active++;
      try {
        const prompt = (await readFile(profile.file, 'utf8')).trim();
        if (!prompt) throw new Error(`Empty agent profile: ${profile.file}`);
        const skills = profile.folder && join(profile.folder, 'skills');
        const args = ['-p', '--mode', 'text', '--no-session', '--offline', '--no-approve', '--no-extensions', '--no-mcp', '--no-prompt-templates', '--no-context-files',
          ...(skills && (await kind(skills))?.isDirectory() ? ['--skill', skills] : []),
          '-e', join(agentDir, 'extensions', 'codex-web-search.ts'), '--tools', 'read,ls,find,grep,web_search',
          ...(ctx.model ? ['--provider', ctx.model.provider, '--model', ctx.model.id] : []),
          '--system-prompt', `${prompt}\n\nResolve relative references in this profile against ${dirname(profile.file)}. The task working directory is ${ctx.cwd}.`, `Research assignment:\n${task}`];
        onUpdate?.({ content: [{ type: 'text', text: `${role} is researching…` }], details: { role } });
        const r = await pi.exec(join(agentDir, 'bin', 'pi'), args, { cwd: ctx.cwd, signal, timeout: 15 * 60_000, maxBuffer: 256 * 1024 });
        signal?.throwIfAborted();
        if (r.killed || r.truncated) throw new Error(`${role} exceeded its time or output limit`);
        if (r.code !== 0) throw new Error(`${role} failed (${r.code}): ${r.stderr.trim().slice(-1200)}`);
        const report = r.stdout.trim();
        if (!report) throw new Error(`${role} returned no report`);
        return { content: [{ type: 'text', text: report }], details: { role } };
      } finally { active--; }
    },
  });
}
