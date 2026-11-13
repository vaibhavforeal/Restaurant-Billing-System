// Metro for MasalaPOS Cafe inside the npm workspace.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const upstream = config.resolver.resolveRequest;
// The Windows POS keeps React 19.2 at the repository root; React Native 0.88 needs the 19.3 copy installed in this
// app's own node_modules. Every `react` import in the bundle, including those from hoisted libraries, resolves here.
const appOrigin = path.join(__dirname, "package.json");

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  if (moduleName === "react" || moduleName.startsWith("react/")) {
    return resolve({ ...context, originModulePath: appOrigin }, moduleName, platform);
  }
  // The shared packages import their own files as "./gst.js" although the files are ".ts".
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try { return resolve(context, moduleName.slice(0, -3), platform); } catch { /* a real .js file: fall through */ }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
