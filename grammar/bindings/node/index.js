const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const prebuildsDir = path.join(root, "prebuilds");

function hasPackagedPrebuilds(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory());
    } catch (_) {
        return false;
    }
}

const previousPrebuildsOnly = process.env.PREBUILDS_ONLY;

if (hasPackagedPrebuilds(prebuildsDir)) {
    process.env.PREBUILDS_ONLY = "1";
}

try {
    module.exports = require("node-gyp-build")(root);
} finally {
    if (previousPrebuildsOnly === undefined) {
        delete process.env.PREBUILDS_ONLY;
    } else {
        process.env.PREBUILDS_ONLY = previousPrebuildsOnly;
    }
}

try {
    module.exports.nodeTypeInfo = require("../../src/node-types.json");
} catch (_) { }
