'use strict';
// Stand-in for `dotenv`: the harness controls the environment explicitly, so
// config() never reads a .env file.
function config() { return { parsed: {} }; }
function parse() { return {}; }
function populate() {}
module.exports = { config, parse, populate, configDotenv: config };
