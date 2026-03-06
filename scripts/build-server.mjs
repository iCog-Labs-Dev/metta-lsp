import { build } from 'esbuild';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'server', 'src');
const outDir = path.join(rootDir, 'server', 'dist');

function collectTypeScriptFiles(dir, files = []) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectTypeScriptFiles(fullPath, files);
            continue;
        }
        if (entry.isFile() && fullPath.endsWith('.ts')) {
            files.push(fullPath);
        }
    }
    return files;
}

const entryPoints = collectTypeScriptFiles(sourceDir);

if (entryPoints.length === 0) {
    throw new Error(`No TypeScript files found in ${sourceDir}`);
}

await build({
    entryPoints,
    outdir: outDir,
    outbase: sourceDir,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    bundle: false,
    sourcemap: false
});

mkdirSync(outDir, { recursive: true });
