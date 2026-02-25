const { URL } = require('url');
const keywordData = require('./keywords.json');

const KEYWORD_SET = new Set(keywordData.classification?.keywords || []);
const CONSTANT_SET = new Set(keywordData.classification?.constants || []);
const BUILTIN_ENTRIES = keywordData.builtins || {};

function getCategory(symbol) {
    if (KEYWORD_SET.has(symbol)) return 'keyword';
    if (CONSTANT_SET.has(symbol)) return 'constant';
    return 'builtin';
}

function pushSection(lines, title, content) {
    if (!content || (Array.isArray(content) && content.length === 0)) return;
    lines.push(`**${title}**`);
    if (Array.isArray(content)) {
        for (const line of content) lines.push(line);
    } else {
        lines.push(content);
    }
    lines.push('');
}

function formatBuiltinMarkdown(symbol, entry, category) {
    const lines = [];
    const kind = entry.kind || category;
    lines.push(`**\`${symbol}\`** (${category}, ${kind})`);
    lines.push('');

    if (entry.summary) pushSection(lines, 'Summary', entry.summary);
    if (entry.description && entry.description !== entry.summary) {
        pushSection(lines, 'Description', entry.description);
    }

    if (Array.isArray(entry.signatures) && entry.signatures.length > 0) {
        pushSection(lines, 'Signatures', [
            '```metta',
            ...entry.signatures,
            '```'
        ]);
    }

    if (Array.isArray(entry.params) && entry.params.length > 0) {
        const paramLines = entry.params.map((param, idx) => {
            const name = param?.name || `$${idx + 1}`;
            const type = param?.type || 'Any';
            const description = param?.description ? ` - ${param.description}` : '';
            return `- \`${name}\` (\`${type}\`)${description}`;
        });
        pushSection(lines, 'Parameters', paramLines);
    }

    if (entry.returns && (entry.returns.type || entry.returns.description)) {
        const retType = entry.returns.type ? `\`${entry.returns.type}\`` : '`Any`';
        const retDesc = entry.returns.description ? ` - ${entry.returns.description}` : '';
        pushSection(lines, 'Returns', `${retType}${retDesc}`);
    }

    if (Array.isArray(entry.examples) && entry.examples.length > 0) {
        const exampleLines = [];
        for (const example of entry.examples) {
            if (example.expr) {
                exampleLines.push('```metta');
                exampleLines.push(example.expr);
                exampleLines.push('```');
            }
            if (example.result) {
                exampleLines.push(`Result: \`${example.result}\``);
            }
            exampleLines.push('');
        }
        while (exampleLines.length > 0 && exampleLines[exampleLines.length - 1] === '') {
            exampleLines.pop();
        }
        pushSection(lines, 'Examples', exampleLines);
    }

    if (entry.source) {
        pushSection(lines, 'Source', `[Corelib documentation](${entry.source})`);
    }

    return lines.join('\n').trim();
}

const BUILTIN_META = new Map();
const BUILTIN_DOCS = new Map();

for (const [symbol, entry] of Object.entries(BUILTIN_ENTRIES)) {
    const category = getCategory(symbol);
    BUILTIN_META.set(symbol, {
        category,
        source: entry.source || null,
        signatures: Array.isArray(entry.signatures) ? entry.signatures : [],
        kind: entry.kind || null
    });
    BUILTIN_DOCS.set(symbol, formatBuiltinMarkdown(symbol, entry, category));
}

const BUILTIN_SYMBOLS = new Set(BUILTIN_META.keys());

function normalizeUri(uri) {
    try {
        const parsed = new URL(uri);
        if (parsed.protocol === 'file:') {
            return parsed.href.toLowerCase();
        }
        return uri;
    } catch (e) {
        return uri;
    }
}

function uriToPath(uri) {
    try {
        const url = new URL(uri);
        if (url.protocol === 'file:') {
            let pathname = decodeURIComponent(url.pathname);
            if (process.platform === 'win32' && pathname.match(/^\/[a-zA-Z]:/)) {
                pathname = pathname.slice(1);
            }
            return pathname;
        }
    } catch (e) { }
    return null;
}

function isRangeEqual(range1, range2) {
    return range1.start.line === range2.start.line &&
        range1.start.character === range2.start.character &&
        range1.end.line === range2.end.line &&
        range1.end.character === range2.end.character;
}

module.exports = {
    BUILTIN_SYMBOLS,
    BUILTIN_DOCS,
    BUILTIN_META,
    normalizeUri,
    uriToPath,
    isRangeEqual
};
