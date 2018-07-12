const fs = require('fs');
const HOME = require('os').homedir;

const configJSON = fs.readFileSync(`${HOME}/.ballin-scripts/config/config.json`);
const configObj = JSON.parse(configJSON);

const getConfig = keys => keys.split('.').reduce((res, key) => res[key], configObj)

const setConfig = (keys, value) => {

}

module.exports = { getConfig, setConfig };
