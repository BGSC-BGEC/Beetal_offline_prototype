// Let Metro bundle ../shared (pure TS shared with the server).
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../shared')];
module.exports = config;
