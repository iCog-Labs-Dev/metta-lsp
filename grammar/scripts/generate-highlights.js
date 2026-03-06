#!/usr/bin/env node
/**
 * Regenerates keyword sections of highlights.scm from metta-stdlib.json.
 * Run via: npm run generate-highlights (from the grammar/ directory)
 *
 * Contract: highlights.scm must contain the region markers:
 *   ; <<GENERATED:keywords>>  ...  ; <</GENERATED:keywords>>
 *   ; <<GENERATED:builtins>>  ...  ; <</GENERATED:builtins>>
 *   ; <<GENERATED:constants>> ...  ; <</GENERATED:constants>>
 */

const fs = require('fs');
const path = require('path');

const STDLIB_JSON = path.resolve(__dirname, '../../metta-stdlib.json');
const HIGHLIGHTS_SCM = path.resolve(__dirname, '../queries/metta/highlights.scm');
const DEFAULT_KEYWORDS = ['if', 'let', 'let*', 'match', 'case', 'collapse', 'superpose'];
const DEFAULT_CONSTANTS = ['True', 'False', 'Nil', 'empty', 'Cons', 'Error'];

const STDLIB_JSON_DATA = JSON.parse(fs.readFileSync(STDLIB_JSON, 'utf8'));
const entries = Object.entries(STDLIB_JSON_DATA.builtins || {});
const inferredKeywords = entries
    .filter(([, data]) => data?.kind === 'keyword')
    .map(([name]) => name);
const inferredConstants = entries
    .filter(([, data]) => data?.kind === 'constant')
    .map(([name]) => name);
const keywords = inferredKeywords.length > 0 ? inferredKeywords : DEFAULT_KEYWORDS;
const constants = inferredConstants.length > 0 ? inferredConstants : DEFAULT_CONSTANTS;
const builtinNames = entries.map(([name]) => name);
const excluded = new Set([...keywords, ...constants]);
const builtins = builtinNames.filter(name => !excluded.has(name));

function toAnyOf(values) {
    return values.map(v => `"${v}"`).join(' ');
}

function buildBlock(category, captures) {
    const lines = captures.map(({ label, values }) => {
        if (!values.length) return '';
        return `((symbol) @${label}\n  (#any-of? @${label} ${toAnyOf(values)}))`;
    }).filter(Boolean).join('\n\n');
    return `; <<GENERATED:${category}>>\n${lines}\n; <</GENERATED:${category}>>`;
}

const blocks = {
    keywords: buildBlock('keywords', [
        { label: 'keyword', values: keywords }
    ]),
    builtins: buildBlock('builtins', [
        { label: 'function.builtin', values: builtins }
    ]),
    constants: buildBlock('constants', [
        { label: 'constant', values: constants }
    ]),
};

let scm = fs.readFileSync(HIGHLIGHTS_SCM, 'utf8');

for (const [category, block] of Object.entries(blocks)) {
    const pattern = new RegExp(
        `; <<GENERATED:${category}>>[\\s\\S]*?; <</GENERATED:${category}>>`,
        'g'
    );
    if (!pattern.test(scm)) {
        console.error(`ERROR: Region marker <<GENERATED:${category}>> not found in highlights.scm`);
        process.exit(1);
    }
    scm = scm.replace(
        new RegExp(`; <<GENERATED:${category}>>[\\s\\S]*?; <</GENERATED:${category}>>`, 'g'),
        block
    );
}

fs.writeFileSync(HIGHLIGHTS_SCM, scm, 'utf8');
console.log('highlights.scm regenerated successfully.');
