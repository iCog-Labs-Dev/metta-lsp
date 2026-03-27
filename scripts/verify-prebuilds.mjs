import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const prebuildsDir = path.join(rootDir, 'grammar', 'prebuilds');

function parseArgs(argv) {
    const options = {
        current: false,
        platforms: []
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--current') {
            options.current = true;
            continue;
        }
        if (arg === '--platforms') {
            const value = argv[index + 1] ?? '';
            options.platforms = value.split(',').map((entry) => entry.trim()).filter(Boolean);
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return options;
}

function getAvailablePrebuilds(dir) {
    try {
        const tuples = readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
                const tupleDir = path.join(dir, entry.name);
                const files = readdirSync(tupleDir, { withFileTypes: true })
                    .filter((file) => file.isFile() && file.name.endsWith('.node'))
                    .map((file) => file.name)
                    .sort();

                return {
                    tuple: entry.name,
                    files
                };
            })
            .filter((entry) => entry.files.length > 0)
            .sort((left, right) => left.tuple.localeCompare(right.tuple));

        return tuples;
    } catch {
        return [];
    }
}

function fail(message, available) {
    const detail = available.length === 0
        ? 'none'
        : available.map((entry) => `${entry.tuple} (${entry.files.join(', ')})`).join('; ');

    console.error(`${message}\nFound prebuilds: ${detail}`);
    process.exit(1);
}

const options = parseArgs(process.argv.slice(2));
const available = getAvailablePrebuilds(prebuildsDir);

if (available.length === 0) {
    fail(`No packaged grammar prebuilds were found in ${prebuildsDir}.`, available);
}

if (options.current) {
    const currentTuple = `${os.platform()}-${os.arch()}`;
    const found = available.some((entry) => entry.tuple === currentTuple);
    if (!found) {
        fail(`Missing a prebuild for the current platform tuple "${currentTuple}".`, available);
    }
}

if (options.platforms.length > 0) {
    for (const platformName of options.platforms) {
        const found = available.some((entry) => entry.tuple.startsWith(`${platformName}-`));
        if (!found) {
            fail(`Missing a packaged prebuild for platform "${platformName}".`, available);
        }
    }
}

console.log(
    `Verified packaged grammar prebuilds: ${available.map((entry) => entry.tuple).join(', ')}`
);
